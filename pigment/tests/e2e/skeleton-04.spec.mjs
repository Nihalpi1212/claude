// Pigment 0.4 skeleton smoke spec (port 8800, ARCHITECTURE.md "0.4 features", Part 2 step 10). Steps 2 and 3 of
// the skeleton land the first tests here (sessions, command observers, the document store); later steps add theirs.
import { test, expect } from '@playwright/test';
import { openApp, newDoc, runAwait, run, confirmDialog, screenPoint } from './helpers.mjs';
import { buildMenuTemplate } from '../../src/main/menu.js';

// This spec stays green before and after each 0.4 package lands (ARCHITECTURE.md "0.4 features", rule 8): an assertion
// about a stub's own behaviour runs only while the stub is still there. A package has landed when the first of its M.7
// stub ids is no longer in app.stubbed; a widget's owner has landed when fields.js isStubWidget(type) is false.
const OWNER_STUB = {
  'type-editing': 'edit:paste-without-formatting',
  'type-paragraph-panel': 'window:panel-paragraph',
  'layer-style-blending': 'layer:style-toggle-all',
  'adjust-tonal': 'image:adjust-levels-last',
  gradients: 'window:panel-gradients',
  patterns: 'window:panel-patterns',
  'guides-snapping': 'view:snap-to',
  'masks-vector-masks': 'layer:vector-mask',
  'shapes-live': 'layer:copy-shape-attributes',
  'layers-panel-depth': 'layer:panel-options',
  'finish-layer-menu': 'layer:merge-group',
  'conventions-shortcuts-fields': 'edit:search',
};
/** { [package]: true when it has landed } for the packages of OWNER_STUB, and { widget: true when still the stub }. */
async function landed(page) {
  return page.evaluate(async (owners) => {
    const app = window.pigmentApp;
    const { isStubWidget } = await import('/lib/fields.js');
    const out = Object.fromEntries(Object.entries(owners).map(([pkg, id]) => [pkg, !app.stubbed.includes(id)]));
    out.stubWidget = Object.fromEntries(['numeric', 'font-size', 'gradient', 'pattern', 'contour', 'preset', 'paint'].map((t) => [t, isStubWidget(t)]));
    return out;
  }, OWNER_STUB);
}

test('no module replaces commands.run; sessions and observers answer instead', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  const info = await page.evaluate(async () => {
    const app = window.pigmentApp;
    const { CommandRegistry } = await import('/lib/commands.js');
    const seen = [];
    const off = app.commands.observe({ before: (id, arg, source) => ({ id, source }), after: (t, r, i) => seen.push([t.id, t.source, i.handledBy, i.refused]) });
    // a slow operation refuses a menu accelerator (source 'menu-key') and lets code through
    let release;
    const busy = app.busy('Testing', () => new Promise((r) => (release = r)));
    await new Promise((r) => setTimeout(r, 50));
    const depth = app.busyDepth;
    const before = app.doc.layers().length;
    app.commands.run('layer:new', undefined, 'menu-key');
    const refused = app.doc.layers().length === before;
    release();
    await busy;
    off();
    return {
      own: Object.prototype.hasOwnProperty.call(app.commands, 'run'),
      proto: app.commands.run === CommandRegistry.prototype.run,
      sessions: app.sessions.list().map((s) => s.id),
      depth,
      after: app.busyDepth,
      refused,
      seen,
    };
  });
  expect(info.own).toBe(false);
  expect(info.proto).toBe(true);
  expect(info.sessions).toEqual([]);
  expect(info.depth).toBe(1);
  expect(info.after).toBe(0);
  expect(info.refused).toBe(true);
  expect(info.seen).toContainEqual(['layer:new', 'menu-key', null, true]);
  expect(errors).toEqual([]);
});

test('Edit > Undo goes through app.historyStep: a session that claims undo answers before the history', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  const r = await page.evaluate(async () => {
    const app = window.pigmentApp;
    await app.commands.run('layer:new', undefined, 'api');
    const n = app.doc.layers().length;
    let claimed = 0;
    const off = app.sessions.register({ id: 'test-observe', policy: 'observe', label: 'Test', undo: () => (claimed++, true) });
    app.commands.run('edit:undo', undefined, 'api');
    const kept = app.doc.layers().length;
    off();
    app.commands.run('edit:undo', undefined, 'api');
    return { n, claimed, kept, after: app.doc.layers().length, isText: app.isTextTarget(document.body) };
  });
  expect(r.claimed).toBe(1);
  expect(r.kept).toBe(r.n);
  expect(r.after).toBe(r.n - 1);
  expect(r.isText).toBe(false);
  expect(errors).toEqual([]);
});

test('document store: guides keep ids and colours through undo, Image Size and .pigment version 3; unknown collections survive', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 200, height: 100 });
  const first = await page.evaluate(() => {
    const d = window.pigmentApp.doc;
    d.store.add('guides', { axis: 'x', pos: 50, color: '#ff8800' }, { label: 'New Guide' });
    d.store.add('guides', { axis: 'y', pos: 20 }, { label: 'New Guide' });
    // a collection of a newer release, written by hand the way 0.5 would
    d.store.raw.set('comps', { v: 2, data: [{ name: 'Comp 1', visible: ['L1'] }] });
    const g = d.guides;
    let threw = false;
    try {
      g.push({ axis: 'x', pos: 1 });
    } catch {
      threw = true;
    }
    return { guides: g.map((x) => ({ ...x })), threw, entries: d.history.entries.length };
  });
  expect(first.threw).toBe(true);
  expect(first.guides).toMatchObject([{ axis: 'x', pos: 50, color: '#ff8800' }, { axis: 'y', pos: 20 }]);
  expect(first.guides.every((g) => typeof g.id === 'string' && g.id)).toBe(true);
  expect(Object.keys(first.guides[1])).toEqual(['id', 'axis', 'pos']);
  // undo and redo of a store entry
  const undone = await page.evaluate(() => {
    const d = window.pigmentApp.doc;
    d.history.undo();
    const n = d.guides.length;
    d.history.redo();
    return [n, d.guides.length];
  });
  expect(undone).toEqual([1, 2]);
  // Image Size 200 %: guides scale, ids and colours stay; one undo restores
  await runAwait(page, 'image:size', { width: 400, height: 200 });
  const scaled = await page.evaluate(() => window.pigmentApp.doc.guides.map((g) => ({ ...g })));
  expect(scaled.map((g) => g.pos)).toEqual([100, 40]);
  expect(scaled.map((g) => g.id)).toEqual(first.guides.map((g) => g.id));
  expect(scaled[0].color).toBe('#ff8800');
  await page.evaluate(() => window.pigmentApp.doc.history.undo());
  expect(await page.evaluate(() => window.pigmentApp.doc.guides.map((g) => g.pos))).toEqual([50, 20]);
  // save as .pigment version 3, read document.json, reopen
  await page.evaluate(() => (window.__pigmentTest.nextSavePath = 'mem:/store.pigment'));
  await runAwait(page, 'file:save-as');
  await expect.poll(() => page.evaluate(() => !!window.__pigmentTest.written['mem:/store.pigment'])).toBe(true);
  const json = await page.evaluate(async () => {
    const { readZip, findEntry, streamCodecs } = await import('/shared/zip.js');
    const entries = await readZip(window.__pigmentTest.written['mem:/store.pigment'], { inflate: streamCodecs.inflate });
    return JSON.parse(new TextDecoder().decode(findEntry(entries, 'document.json').data));
  });
  expect(json.version).toBe(3);
  expect(json.guides).toEqual([{ axis: 'x', pos: 50 }, { axis: 'y', pos: 20 }]);
  expect(json.store.guides.v).toBe(1);
  expect(json.store.guides.data).toMatchObject([{ axis: 'x', pos: 50, color: '#ff8800' }, { axis: 'y', pos: 20 }]);
  expect(json.store.comps).toEqual({ v: 2, data: [{ name: 'Comp 1', visible: ['L1'] }] });
  await page.evaluate(() => (window.__pigmentTest.files['mem:/again.pigment'] = window.__pigmentTest.written['mem:/store.pigment']));
  await runAwait(page, 'file:open-paths', ['mem:/again.pigment']);
  await expect.poll(() => page.evaluate(() => window.pigmentApp.doc.path)).toBe('mem:/again.pigment');
  const back = await page.evaluate(() => {
    const d = window.pigmentApp.doc;
    return { guides: d.guides.map((g) => ({ ...g })), comps: d.store.toJSON().comps, dirty: d.history.dirty };
  });
  expect(back.guides).toEqual(first.guides);
  expect(back.comps).toEqual({ v: 2, data: [{ name: 'Comp 1', visible: ['L1'] }] });
  expect(back.dirty).toBe(false);
  expect(errors).toEqual([]);
});

test('a version 2 .pigment opens with its guides in the store (ids added)', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 120, height: 80 });
  await page.evaluate(() => (window.__pigmentTest.nextSavePath = 'mem:/v3.pigment'));
  await runAwait(page, 'file:save-as');
  await expect.poll(() => page.evaluate(() => !!window.__pigmentTest.written['mem:/v3.pigment'])).toBe(true);
  // rewrite document.json as Pigment 0.3 would have written it: version 2, no store, plain guides
  await page.evaluate(async () => {
    const { readZip, writeZip, findEntry, streamCodecs } = await import('/shared/zip.js');
    const entries = await readZip(window.__pigmentTest.written['mem:/v3.pigment'], { inflate: streamCodecs.inflate });
    const doc = findEntry(entries, 'document.json');
    const json = JSON.parse(new TextDecoder().decode(doc.data));
    json.version = 2;
    delete json.store;
    json.guides = [{ axis: 'x', pos: 30 }, { axis: 'y', pos: 12.5 }];
    doc.data = new TextEncoder().encode(JSON.stringify(json));
    window.__pigmentTest.files['mem:/v2.pigment'] = await writeZip(entries.map((e) => ({ name: e.name, data: e.data })), { deflate: streamCodecs.deflate });
  });
  await runAwait(page, 'file:open-paths', ['mem:/v2.pigment']);
  await expect.poll(() => page.evaluate(() => window.pigmentApp.doc.path)).toBe('mem:/v2.pigment');
  const guides = await page.evaluate(() => window.pigmentApp.doc.guides.map((g) => ({ ...g })));
  expect(guides).toMatchObject([{ axis: 'x', pos: 30 }, { axis: 'y', pos: 12.5 }]);
  expect(guides.every((g) => typeof g.id === 'string' && g.id)).toBe(true);
  expect(errors).toEqual([]);
});

// ---- step 5: rich text through the type facade ------------------------------------------------------------------

test('the canvas stub engine draws single-style text exactly like 0.3, and two runs in their colours', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  const r = await page.evaluate(async () => {
    const { TextLayer, createCanvas, cssFont, measureContext } = await import('/lib/document.js');
    const api = await import('/lib/type/api.js');
    const M = await import('/lib/type/model.js');
    const { parseColor, rgbaToHex } = await import('/shared/pixels/color.js');
    api.setEngine('canvas');
    // ---- 0.3's TextLayer.layout / baseBounds / renderBase / drawSpaced, copied (lib/document.js at 0.3.1) ----
    function drawSpaced(ctx, text, x, y, spacing, stroke) {
      const paint = (t, px) => {
        if (stroke && stroke.width > 0) {
          ctx.lineWidth = stroke.width;
          ctx.strokeStyle = stroke.color ?? '#000';
          ctx.lineJoin = 'round';
          ctx.strokeText(t, px, y);
        }
        ctx.fillText(t, px, y);
      };
      if (!spacing) return paint(text, x);
      let cx = x;
      for (const ch of text) {
        paint(ch, cx);
        cx += ctx.measureText(ch).width + spacing;
      }
    }
    function layout03(L) {
      const ctx = measureContext();
      ctx.font = cssFont(L.font);
      const lineHeight = L.font.size * L.font.lineHeight;
      const words = L.text.split('\n');
      const lines = [];
      const spacing = L.font.letterSpacing;
      const widthOf = (s) => ctx.measureText(s).width + Math.max(0, s.length - 1) * spacing;
      for (const para of words) {
        if (L.width === null || !para) {
          lines.push({ text: para, width: widthOf(para) });
          continue;
        }
        let line = '';
        for (const word of para.split(' ')) {
          const next = line ? `${line} ${word}` : word;
          if (widthOf(next) <= L.width || !line) line = next;
          else {
            lines.push({ text: line, width: widthOf(line) });
            line = word;
          }
        }
        lines.push({ text: line, width: widthOf(line) });
      }
      const width = L.width ?? Math.max(1, ...lines.map((l) => l.width));
      return { lines, lineHeight, width: Math.ceil(width), height: Math.ceil(lines.length * lineHeight), ascent: L.font.size * 0.8 };
    }
    function bounds03(L) {
      const l = layout03(L);
      const pad = Math.ceil(L.font.size * 0.3) + (L.font.stroke?.width ?? 0);
      return { x: Math.floor(L.x - pad), y: Math.floor(L.y - pad), width: Math.ceil(l.width + pad * 2), height: Math.ceil(l.height + pad * 2) };
    }
    function render03(L) {
      const l = layout03(L);
      const b = bounds03(L);
      const canvas = createCanvas(b.width, b.height);
      const ctx = canvas.getContext('2d');
      ctx.font = cssFont(L.font);
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = rgbaToHex(parseColor(L.font.color), true);
      const ox = L.x - b.x, oy = L.y - b.y;
      l.lines.forEach((line, i) => {
        let x = ox;
        if (L.font.align === 'center') x = ox + (l.width - line.width) / 2;
        else if (L.font.align === 'right') x = ox + l.width - line.width;
        const y = oy + l.ascent + i * l.lineHeight;
        drawSpaced(ctx, line.text, x, y, L.font.letterSpacing, L.font.stroke);
        if (L.font.underline) ctx.fillRect(x, y + L.font.size * 0.12, line.width, Math.max(1, L.font.size / 16));
      });
      return { canvas, x: b.x, y: b.y };
    }
    // --------------------------------------------------------------------------------------------------------------
    const cases = [
      { text: 'Hello world', x: 20.5, y: 30, width: null, font: { family: 'Arial', size: 36, color: '#0000ff' } },
      { text: 'A paragraph of  several words that wraps into lines\n\n second  para', x: 10, y: 12.25, width: 140, font: { family: 'Arial', size: 18, color: '#008000', align: 'center', lineHeight: 1.5 } },
      { text: 'Right aligned text in a box', x: 7, y: 9, width: 101.5, font: { family: 'Georgia', size: 15, color: '#333333', align: 'right', italic: true, weight: 700 } },
      { text: 'Spaced\nand stroked', x: 3, y: 4, width: null, font: { family: 'Arial', size: 7, color: '#ff0000', letterSpacing: 0.5, underline: true, stroke: { color: '#00ffff', width: 2 }, lineHeight: 1.37 } },
      { text: ' leading space wraps', x: 0, y: 0, width: 60, font: { family: 'Arial', size: 20, color: '#000000', letterSpacing: 1.25 } },
    ];
    const same = [];
    for (const c of cases) {
      const layer = new TextLayer({ ...c });
      const a = layer.renderBase();
      const legacy = { ...c, font: { ...layer.font }, text: c.text };
      const b = render03(legacy);
      const da = a.canvas.getContext('2d').getImageData(0, 0, a.canvas.width, a.canvas.height).data;
      const db = b.canvas.getContext('2d').getImageData(0, 0, b.canvas.width, b.canvas.height).data;
      let diff = da.length === db.length ? 0 : -1;
      if (diff === 0) for (let i = 0; i < da.length; i++) if (da[i] !== db[i]) diff++;
      const l3 = layout03(legacy), l4 = layer.layout();
      same.push({ box: [a.x, a.y, a.canvas.width, a.canvas.height].join(',') === [b.x, b.y, b.canvas.width, b.canvas.height].join(','), diff, lines: JSON.stringify(l4.lines.map((l) => [l.text, l.width])) === JSON.stringify(l3.lines.map((l) => [l.text, l.width])), height: l4.height === l3.height && l4.width === l3.width });
    }
    // two runs: red then blue
    let content = M.fromPlain('RRRR BBBB', { size: 40, color: '#ff0000' });
    content = M.applyChar(content, 5, 9, { color: '#0000ff' });
    const two = new TextLayer({ content, x: 10, y: 10 });
    const out = two.renderBase();
    const d = out.canvas.getContext('2d').getImageData(0, 0, out.canvas.width, out.canvas.height).data;
    let red = 0, blue = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 200) continue;
      if (d[i] > 200 && d[i + 2] < 60) red++;
      if (d[i + 2] > 200 && d[i] < 60) blue++;
    }
    const lay = two.layout();
    api.setEngine(null);
    return { same, red, blue, runs: lay.lines[0].runs.map((x) => [x.from, x.to, x.style.color]), engines: api.engines() };
  });
  for (const s of r.same) expect(s).toEqual({ box: true, diff: 0, lines: true, height: true });
  expect(r.red).toBeGreaterThan(50);
  expect(r.blue).toBeGreaterThan(50);
  expect(r.runs).toEqual([[0, 5, '#ff0000'], [5, 9, '#0000ff']]);
  expect(r.engines).toContain('canvas');
  expect(errors).toEqual([]);
});

test('typing into the second run through the textarea keeps both runs; undo restores the formatting', async ({ page }) => {
  const errors = await openApp(page);
  test.skip((await landed(page))['type-editing'], 'type-editing replaced the 0.3 textarea session; its own spec types into runs');
  await newDoc(page);
  await page.evaluate(async () => {
    const app = window.pigmentApp;
    const { TextLayer } = await import('/lib/document.js');
    const M = await import('/lib/type/model.js');
    let content = M.fromPlain('Hello World', { size: 40, color: '#ff0000' });
    content = M.applyChar(content, 6, 11, { color: '#0000ff', underline: true });
    app.doc.add(new TextLayer({ content, x: 20, y: 40 }));
    app.doc.setActive(app.doc.layers().at(-1));
  });
  await runAwait(page, 'layer:edit-text');
  await expect.poll(() => page.evaluate(() => !!window.pigmentApp.tools.active.session)).toBe(true);
  await page.evaluate(() => window.pigmentApp.tools.active.session.textarea.setSelectionRange(8, 8));
  await page.keyboard.type('X');
  await page.keyboard.press('Control+Enter');
  const after = await page.evaluate(() => {
    const l = window.pigmentApp.doc.active;
    return { text: l.text, runs: l.content.runs.map((r) => [r.len, r.style.color ?? null, !!r.style.underline]), font: l.font.color };
  });
  expect(after).toEqual({ text: 'Hello WoXrld', runs: [[6, '#ff0000', false], [6, '#0000ff', true]], font: '#ff0000' });
  // the type target reads MIXED colours over both runs; setLayerProps through `font` flattens, undo brings the runs back
  const mixed = await page.evaluate(async () => {
    const app = window.pigmentApp;
    const t = await import('/lib/type/target.js');
    const M = await import('/lib/type/model.js');
    const attrs = t.readChar(app);
    const { setLayerProps } = await import('/lib/layer-ops.js');
    const l = app.doc.active;
    setLayerProps(app, l, { font: { ...l.font, color: '#00ff00' } }, 'Character');
    const flat = l.content.runs.length;
    await app.commands.run('edit:undo', undefined, 'api');
    return { mixed: attrs.color === M.MIXED, flat, back: l.content.runs.map((r) => r.style.color ?? null) };
  });
  expect(mixed).toEqual({ mixed: true, flat: 2, back: ['#ff0000', '#0000ff'] });
  expect(errors).toEqual([]);
});

test('caretRect, hitTest and selectionRects of text on a path derive from its glyphs', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  const r = await page.evaluate(async () => {
    const { TextLayer } = await import('/lib/document.js');
    const api = await import('/lib/type/api.js');
    const path = { subpaths: [{ closed: false, points: [{ x: 20, y: 150 }, { x: 380, y: 150 }] }] };
    const layer = new TextLayer({ text: 'Pathway', x: 0, y: 0, font: { family: 'Arial', size: 30, color: '#000000' }, pathText: { path, startOffset: 0, flip: false, align: 'left' } });
    const lay = layer.layout();
    const g = lay.glyphs.find((x) => x.index === 2);
    const c = api.caretRect(layer, 2);
    const expectX = g.x - (Math.cos(g.angle) * g.width) / 2 + Math.sin(g.angle) * 24;
    const expectY = g.y - (Math.sin(g.angle) * g.width) / 2 - Math.cos(g.angle) * 24;
    const hit = api.hitTest(layer, g.x + g.width / 4, g.y - 5);
    return { dx: Math.abs(c.x - expectX), dy: Math.abs(c.y - expectY), height: c.height, angle: Math.abs(c.angle - g.angle), hit: hit.index, rects: api.selectionRects(layer, 1, 4).length, hasGlyphs: !!lay.glyphs };
  });
  expect(r.hasGlyphs).toBe(true);
  expect(r.dx).toBeLessThan(1e-9);
  expect(r.dy).toBeLessThan(1e-9);
  expect(r.height).toBe(30);
  expect(r.angle).toBeLessThan(1e-9);
  expect(r.hit).toBe(3);
  expect(r.rects).toBe(3);
  expect(errors).toEqual([]);
});

// ---- step 4: the new layer fields and their geometry ------------------------------------------------------------

test('vector masks, blending and mask density: moves, Image Size, Free Transform, clones and a .pigment round trip', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  const r = await page.evaluate(async () => {
    const app = window.pigmentApp;
    const d = app.doc;
    const { RasterLayer, ShapeLayer, createCanvas, isDefaultBlending, effectiveBlending } = await import('/lib/document.js');
    const { offsetLayers } = await import('/lib/layer-move.js');
    const { writePigment, readPigment } = await import('/lib/io.js');
    const { cloneLayer } = await import('/lib/layer-ops.js');
    const square = (x, y, s) => ({ subpaths: [{ closed: true, points: [{ x, y }, { x: x + s, y }, { x: x + s, y: y + s }, { x, y: y + s }] }] });
    const canvas = createCanvas(100, 100);
    canvas.getContext('2d').fillRect(0, 0, 100, 100);
    const mask = createCanvas(d.width, d.height);
    mask.getContext('2d').fillStyle = '#fff';
    mask.getContext('2d').fillRect(0, 0, d.width, d.height);
    const layer = new RasterLayer({ name: 'Masked', canvas, x: 10, y: 10, vectorMask: { path: square(20, 20, 40), initialFill: 'reveal' }, blending: { knockout: 'shallow', channels: { g: false } } });
    layer.mask = { canvas: mask, enabled: true, linked: true, density: 0.5, feather: 2 };
    d.add(layer);
    const shape = new ShapeLayer({ name: 'Rect', path: square(200, 50, 30), shapeKind: 'rect', shapeProps: { x: 200, y: 50, width: 30, height: 30, radius: 0 } });
    d.add(shape);
    const firstX = (l) => l.vectorMask.path.subpaths[0].points[0].x;
    offsetLayers(d, [layer, shape], 7, 3);
    const moved = { mask: firstX(layer), props: [shape.shapeProps.x, shape.shapeProps.y], path: shape.path.subpaths[0].points[0].x };
    await app.commands.run('edit:undo', undefined, 'api');
    const undone = { mask: firstX(d.find(layer.id)), props: d.find(shape.id).shapeProps.x };
    // Image Size maps the vector mask through the whole-document matrix
    await app.commands.run('image:size', { width: 800, height: 600, method: 'bilinear', scaleStyles: true }, 'api');
    const scaled = firstX(d.find(layer.id));
    // Free Transform: the linked vector mask follows the same matrix (one entry with the pixels)
    const tt = app.transformTool;
    d.setActive(d.find(layer.id));
    tt.start({ mode: 'free' });
    tt.session.quad = tt.session.quad.map(([x, y]) => [x + 10, y + 5]);
    tt.commit();
    const transformed = [firstX(d.find(layer.id)), d.find(layer.id).vectorMask.path.subpaths[0].points[0].y];
    await app.commands.run('edit:undo', undefined, 'api');
    const copy = cloneLayer(d.find(layer.id));
    const copied = { mask: firstX(copy), separate: copy.vectorMask !== d.find(layer.id).vectorMask, blending: copy.blending.knockout, density: copy.mask.density };
    // .pigment version 3
    const back = await readPigment(await writePigment(d));
    const l2 = back.find(layer.id);
    return {
      moved, undone, scaled, copied, transformed,
      saved: { mask: l2.vectorMask, blending: l2.blending, def: isDefaultBlending(l2.blending), g: effectiveBlending(l2).channels.g, density: l2.mask.density, feather: l2.mask.feather },
      plain: { vm: back.layers()[0].vectorMask, bl: back.layers()[0].blending },
    };
  });
  expect(r.moved).toEqual({ mask: 27, props: [207, 53], path: 207 });
  expect(r.undone).toEqual({ mask: 20, props: 200 });
  expect(r.scaled).toBe(40);
  expect(r.transformed).toEqual([50, 45]);
  expect(r.copied).toEqual({ mask: 40, separate: true, blending: 'shallow', density: 0.5 });
  expect(r.saved.mask).toMatchObject({ enabled: true, linked: true, density: 1, feather: 0, initialFill: 'reveal' });
  expect(r.saved.mask.path.subpaths[0].points[2]).toEqual({ x: 120, y: 120 });
  expect(r.saved).toMatchObject({ blending: { knockout: 'shallow', channels: { g: false } }, def: false, g: false, density: 0.5, feather: 2 });
  expect(r.plain).toEqual({ vm: null, bl: null });
  expect(errors).toEqual([]);
});

test('paints and patterns: fill layers through the paint editors and renderers, the pattern library, the Paint Bucket module', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 200, height: 100 });
  // the Paint Bucket sits after the Gradient tool in the fill slot, now from lib/tools/bucket.js
  expect(await page.evaluate(() => window.pigmentApp.tools.slots.find((s) => s.id === 'fill').tools)).toEqual(['gradient', 'bucket']);

  // Layer > New Fill Layer > Gradient: the first paint, then 0.3's live Gradient Fill form on the new layer (the stub
  // gradient editor of lib/paint-editors.js; gradients replaces it and tests its own)
  const has = await landed(page);
  if (!has.gradients) {
    await page.evaluate(() => window.pigmentApp.setColors({ foreground: '#ff0000', background: '#0000ff' }));
    await run(page, 'layer:new-fill', 'gradient');
    await expect(page.locator('.dialog')).toContainText('Gradient Fill');
    await confirmDialog(page);
    const g = await page.evaluate(() => {
      const l = window.pigmentApp.doc.active;
      return { type: l.type, v: l.paint.gradient.gradientVersion, stops: l.paint.gradient.stops.map((s) => s.color), from: l.paint.gradient.from };
    });
    expect(g).toEqual({ type: 'fill', v: 2, stops: ['#ff0000', '#0000ff'], from: [0, 50] });
    // drawn exactly like 0.3's Canvas gradient from the left edge to the right edge
    const same = await page.evaluate(() => {
      const d = window.pigmentApp.doc;
      const row = d.view.compositor.composite(d).getContext('2d').getImageData(0, 50, 200, 1).data;
      const c = document.createElement('canvas');
      c.width = 200;
      c.height = 100;
      const ctx = c.getContext('2d');
      const grad = ctx.createLinearGradient(0, 50, 200, 50);
      grad.addColorStop(0, '#ff0000');
      grad.addColorStop(1, '#0000ff');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, 200, 100);
      const ref = ctx.getImageData(0, 50, 200, 1).data;
      return row.every((v, i) => v === ref[i]);
    });
    expect(same).toBe(true);
  }

  // the paint renderer of a version 2 def with an opacity stop and a hard stop, against the reference sampler
  const r = await page.evaluate(async () => {
    const { paintStyle, canvasStops } = await import('/lib/paint.js');
    const { sampleGradient } = await import('/shared/pixels/gradient-model.js');
    const def = { gradientVersion: 2, type: 'solid', interpolation: 'classic', smoothness: 0, stops: [{ pos: 0, mid: 0.5, color: '#000000' }, { pos: 0.5, mid: 0.5, color: '#ff0000' }, { pos: 0.5, mid: 0.5, color: '#00ff00' }, { pos: 1, mid: 0.5, color: '#00ff00' }], opacityStops: [{ pos: 0, mid: 0.5, opacity: 1 }, { pos: 1, mid: 0.5, opacity: 0.5 }] };
    const c = document.createElement('canvas');
    c.width = 101;
    c.height = 1;
    const ctx = c.getContext('2d');
    ctx.fillStyle = paintStyle(ctx, { type: 'gradient', gradient: { ...def, from: [0, 0], to: [100, 0] } }, { x: 0, y: 0, width: 101, height: 1 });
    ctx.fillRect(0, 0, 101, 1);
    const d = ctx.getImageData(0, 0, 101, 1).data;
    const at = (x) => Array.from(d.slice(x * 4, x * 4 + 4));
    const ref = (t) => sampleGradient(def, t).map((v, i) => Math.round(i === 3 ? v * 255 : v));
    return { left: at(25), right: at(75), refLeft: ref(0.25), refRight: ref(0.75), n: canvasStops(def).length };
  });
  for (const [a, b] of [[r.left, r.refLeft], [r.right, r.refRight]]) for (let i = 0; i < 4; i++) expect(Math.abs(a[i] - b[i])).toBeLessThanOrEqual(3);

  // Edit > Define Pattern makes the current pattern of the library; Pattern Fill, Fill and the Pattern Stamp read it
  const p = await page.evaluate(async () => {
    const app = window.pigmentApp;
    const d = app.doc;
    d.setActive(d.layers()[0]);
    app.applySelection((await import('/lib/selection.js')).Selection.fromRect(d.width, d.height, { x: 0, y: 0, width: 4, height: 4 }), 'replace');
    await app.commands.run('edit:define-pattern', undefined, 'api');
    app.applySelection(null, 'replace');
    const cur = app.patterns.current();
    const ref = app.patterns.ref(cur);
    return { has: !!cur, w: cur.width, same: app.currentPattern === cur.canvas, list: app.patterns.list().filter((e) => e === cur || e.id === cur.id).length, ref: typeof ref.dataUrl === 'string' && ref.dataUrl.startsWith('data:image/png'), presetId: ref.presetId === cur.id, legacyArray: Array.isArray(app.patterns) };
  });
  expect(p).toEqual({ has: true, w: 4, same: true, list: 1, ref: true, presetId: true, legacyArray: false });
  if (!has.patterns) {
    // the stub pattern editor's New Fill Layer (patterns replaces the editor and the library)
    await runAwait(page, 'layer:new-fill', 'pattern');
    expect(await page.evaluate(() => [window.pigmentApp.doc.active.type, window.pigmentApp.doc.active.paint.type, window.pigmentApp.doc.active.paint.pattern.canvas === window.pigmentApp.currentPattern])).toEqual(['fill', 'pattern', true]);
  }
  expect(errors).toEqual([]);
});

test('UI registries: field widgets in a form, Properties sections, Preferences sections, Layer Style pages and blending', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 120, height: 80 });
  const has = await landed(page);
  const stub = has.stubWidget;

  // every widget renders in a formDialog and returns its value; the stubs' own controls are checked while they are stubs
  await page.evaluate(() => {
    const app = window.pigmentApp;
    window.__formResult = import('/lib/form.js').then(({ formDialog }) => formDialog(app, {
      title: 'Widgets',
      fields: [
        { key: 'n', label: 'Number', type: 'numeric', value: 5, min: 0, max: 10 },
        { key: 'g', label: 'Gradient', type: 'gradient', value: { kind: 'linear', stops: [{ pos: 0, color: '#ff0000' }, { pos: 1, color: '#0000ff' }] } },
        { key: 'p', label: 'Pattern', type: 'pattern', value: null },
        { key: 'c', label: 'Contour', type: 'contour', value: null },
        { key: 'pr', label: 'Preset', type: 'preset', kind: 'gradients', value: null },
        { key: 'paint', label: 'Paint', type: 'paint', value: { type: 'solid', color: '#00ff00' }, allow: ['none', 'solid', 'gradient'] },
      ],
    }));
  });
  const dialog = page.locator('.dialog');
  if (stub.numeric) {
    await expect(dialog.locator('input[data-key="n"][data-numeric]')).toHaveAttribute('type', 'number');
    await dialog.locator('input[data-key="n"]').fill('7');
    await dialog.locator('input[data-key="n"]').dispatchEvent('change');
  }
  for (const w of ['gradient', 'pattern', 'contour', 'preset', 'paint']) await expect(dialog.locator(`[data-widget="${w}"]`)).toHaveCount(1);
  if (stub.preset && !has.gradients) await expect(dialog.locator('[data-widget="preset"] option')).toHaveCount(9); // Custom + the eight gradients built in
  // the contour widget lists the contours presets (Linear built in) and shows the value's curve
  if (stub.contour) await expect(dialog.locator('[data-widget="contour"] select')).toHaveValue('linear');
  if (stub.paint) await dialog.locator('[data-widget="paint"] .seg-button[data-value="none"]').click();
  // the gradient widget's popover: two end colours and Reverse; what it reports is a version 2 def
  if (stub.gradient) {
    await dialog.locator('[data-widget="gradient"] .field-gradient-bar').click();
    await dialog.locator('[data-widget="gradient"] input[data-key="reverse"]').check();
  }
  await page.locator('.dialog .dialog-buttons .btn.primary').click();
  const values = await page.evaluate(() => window.__formResult);
  expect(values.n).toBe(stub.numeric ? 7 : 5);
  if (stub.gradient) {
    expect(values.g).toMatchObject({ gradientVersion: 2, kind: 'linear', reverse: true });
    expect(values.g.stops.map((s) => s.color)).toEqual(['#ff0000', '#0000ff']);
  } else expect(values.g).toEqual({ kind: 'linear', stops: [{ pos: 0, color: '#ff0000' }, { pos: 1, color: '#0000ff' }] });
  expect(values.c).toBeNull(); // untouched: the form keeps the value it was given
  expect(values.paint).toEqual(stub.paint ? null : { type: 'solid', color: '#00ff00' });

  // Properties: the host shows 0.3's sections, each from lib/properties; a registered section that hides another
  const props = await page.evaluate(async () => {
    const app = window.pigmentApp;
    const d = app.doc;
    app.panels.show('properties', { reveal: true });
    app.properties.render();
    const panel = document.querySelector('.props-panel');
    const before = { ids: app.properties.sections().map((s) => s.id).sort(), transform: !!panel.querySelector('.props-xywh'), mask: panel.querySelector('.props-mask h4')?.textContent };
    let disposed = 0;
    app.properties.registerSection({ id: 'test-hide', order: 5, region: 'main', test: (l) => !!l, hides: ['transform'], render: () => Object.assign(document.createElement('div'), { className: 'test-section', textContent: 'test' }), dispose: () => disposed++ });
    app.properties.render();
    const hidden = { test: !!panel.querySelector('.test-section'), transform: !!panel.querySelector('.props-xywh') };
    d.setActive(null);
    app.properties.render();
    const none = { doc: panel.querySelector('.props-main h4')?.textContent, disposed };
    return { before, hidden, none };
  });
  // the built-in ids (packages may add sections; masks-vector-masks owns the mask section's markup)
  expect(props.before.ids).toEqual(expect.arrayContaining(['adjustment', 'document', 'fill', 'mask', 'paragraph', 'shape', 'text', 'transform']));
  expect(props.before).toMatchObject(has['masks-vector-masks'] ? { transform: true } : { transform: true, mask: 'Layer Mask' });
  expect(props.hidden).toEqual({ test: true, transform: false });
  expect(props.none).toEqual({ doc: 'Canvas', disposed: 1 });

  // Preferences: 0.3's fields in their sections plus Guides, Grid & Slices (the grid spacing moved there)
  await page.evaluate(() => {
    window.__prefs = window.pigmentApp.preferencesDialog();
  });
  // (packages add sections of their own; guides-snapping replaces 'guides' and its grid field)
  const sections = await page.locator('.prefs-dialog .section').allTextContents();
  const builtIn = ['Interface', 'Cursors and tools', 'Canvas', 'Guides, Grid & Slices', 'Performance'].filter((t) => t !== 'Guides, Grid & Slices' || !has['guides-snapping']);
  expect(sections.filter((t) => builtIn.includes(t))).toEqual(builtIn);
  for (const key of ['theme', 'rulerUnit', 'cursorStyle', 'checkerboardSize', 'historyLimit', ...(has['guides-snapping'] ? [] : ['gridSize'])]) await expect(page.locator(`.prefs-dialog [data-key="${key}"]`)).toHaveCount(1);
  if (!has['guides-snapping']) {
    await page.locator('.prefs-dialog input[data-key="gridSize"]').fill('32');
    await page.locator('.prefs-dialog input[data-key="gridSize"]').dispatchEvent('change');
  }
  await page.locator('.prefs-dialog .dialog-buttons .btn.primary').click();
  await page.evaluate(() => window.__prefs);
  if (!has['guides-snapping']) expect(await page.evaluate(() => window.pigmentApp.settings.gridSize)).toBe(32);

  // Layer Style: the Blending Options page comes from lib/blending-options.js; Cancel restores `blending`, OK keeps
  // styles.hidden and commits blending with the styles in one entry
  const r = await page.evaluate(async () => {
    const app = window.pigmentApp;
    const d = app.doc;
    await app.commands.run('layer:new', undefined, 'api');
    const layer = d.active;
    layer.blending = { knockout: 'shallow' };
    const pages = app.layerStyle.pages().map((p) => p.id);
    // Cancel: a page edits the advanced draft live, Cancel puts the layer back
    app.layerStyle.registerPage({ id: 'test-advanced', title: 'Advanced', order: 1, render: (ctx) => {
      ctx.advanced.knockout = 'deep';
      ctx.apply();
      return document.createElement('div');
    } });
    const run1 = app.commands.run('layer:style', 'dialog', 'api');
    await new Promise((res) => requestAnimationFrame(res));
    document.querySelector('.style-dialog [data-style="test-advanced"]').click();
    const live = layer.blending?.knockout;
    document.querySelector('.style-dialog .dialog-buttons [data-value="null"]').click();
    await run1;
    const cancelled = layer.blending?.knockout;
    // OK with hidden effects
    layer.styles = { dropShadow: { enabled: true }, hidden: true };
    const n = d.history.index;
    const run2 = app.commands.run('layer:style', 'dialog', 'api');
    await new Promise((res) => requestAnimationFrame(res));
    document.querySelector('.style-dialog [data-style="test-advanced"]').click();
    document.querySelector('.style-dialog .dialog-buttons .btn.primary').click();
    await run2;
    return { pages, live, cancelled, hidden: layer.styles?.hidden, knockout: layer.blending?.knockout, entries: d.history.index - n, label: d.history.entries[d.history.index].label };
  });
  expect(r.pages).toContain('blending'); // layer-style-effects adds the effect pages
  expect(r).toMatchObject({ live: 'deep', cancelled: 'shallow', hidden: true, knockout: 'deep', entries: 1, label: 'Layer style' });
  expect(errors).toEqual([]);
});

test('hooks placed in other files: snapping, canvas capture, drop handlers, path target kinds, links, move-to, sampling', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 200, height: 200 });
  const has = await landed(page);

  // snap: a Move drag still snaps its layer to a guide (0.3's snapping through app.snap); with the stub, a marquee
  // drag does not (guides-snapping makes it snap)
  await page.evaluate(async () => {
    const app = window.pigmentApp;
    const d = app.doc;
    d.guides = [{ axis: 'x', pos: 100 }];
    await app.commands.run('layer:new', undefined, 'api');
    const l = d.active;
    const c = l.canvas.getContext('2d');
    c.fillStyle = '#ff0000';
    c.fillRect(10, 10, 40, 40);
    l.touch();
    d.changed('pixels', { layer: l });
    app.tools.activate('move');
  });
  const x0 = await page.evaluate(() => window.pigmentApp.doc.active.x);
  const from = await screenPoint(page, 30, 30);
  // the layer's left edge lands 1 px short of the guide at 100: within 6 screen px, so it snaps onto it
  const to = await screenPoint(page, 30 + 99 - x0, 30);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await page.mouse.up();
  expect(await page.evaluate(() => window.pigmentApp.doc.active.x)).toBe(100);
  const marquee = await page.evaluate(() => {
    const app = window.pigmentApp;
    app.tools.activate('marquee-rect');
    const t = app.tools.active;
    const p = (x, y) => ({ x, y, screenX: 0, screenY: 0, shift: false, alt: false, ctrl: false, meta: false });
    t.onPointerDown(p(97, 20));
    t.onPointerMove(p(150, 60), true);
    return t.rect();
  });
  if (!has['guides-snapping']) expect(marquee).toEqual({ x: 97, y: 20, width: 53, height: 40 });

  // canvas capture: while a dialog lets the canvas through, an armed handler gets the click and the tool does not;
  // without one the backdrop click is Cancel, as in 0.3
  const cap = await page.evaluate(async () => {
    const app = window.pigmentApp;
    app.tools.activate('marquee-rect');
    const p = app.dialogs.open({ title: 'Through', content: 'x', width: 200, buttons: [{ label: 'OK', value: true, primary: true }] });
    await new Promise((res) => requestAnimationFrame(res));
    const dialog = document.querySelector('.dialog');
    app.dialogs.setCanvasThrough(dialog, true);
    const got = [];
    const release = app.canvasCapture.push({ id: 'test', down: (pt) => got.push([Math.round(pt.x), Math.round(pt.y)]) });
    window.__cap = { p, release, got, sel: () => !!app.doc.selection };
    return true;
  });
  expect(cap).toBe(true);
  const at = await screenPoint(page, 5, 195); // the canvas's corner, away from the dialog box
  await page.mouse.click(at.x, at.y);
  expect(await page.evaluate(() => [window.__cap.got, window.__cap.sel()])).toEqual([[[5, 195]], false]);
  await page.evaluate(() => {
    window.__cap.release();
    window.pigmentApp.dialogs.setCanvasThrough(document.querySelector('.dialog'), false);
  });
  await page.mouse.click(at.x, at.y); // the backdrop again: Cancel
  expect(await page.evaluate(() => window.__cap.p)).toBeNull();

  // drop handlers: a gradient dragged from a panel onto a layer row and onto the canvas
  const drops = await page.evaluate(async () => {
    const app = window.pigmentApp;
    app.panels.show('layers', { reveal: true });
    const got = [];
    app.registerDropHandler('application/x-pigment-gradient', { canvas: (data, pt) => got.push(['canvas', JSON.parse(data).kind, Math.round(pt.x)]), layer: (data, layer) => got.push(['layer', layer.id]) });
    const fire = (el, x, y) => {
      const dt = new DataTransfer();
      dt.setData('application/x-pigment-gradient', JSON.stringify({ kind: 'radial' }));
      const over = new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true, clientX: x, clientY: y });
      el.dispatchEvent(over);
      el.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true, clientX: x, clientY: y }));
      return over.defaultPrevented;
    };
    await new Promise((res) => requestAnimationFrame(res));
    const row = document.querySelector(`.layer-row[data-id="${app.doc.active.id}"]`);
    const rowAccepts = fire(row, 0, 0);
    const r = app.view.canvas.getBoundingClientRect();
    const s = app.view.toScreen(40, 40);
    const canvasAccepts = fire(app.view.canvas, r.left + s.x, r.top + s.y);
    return { got, rowAccepts, canvasAccepts, id: app.doc.active.id };
  });
  expect(drops.got).toEqual([['layer', drops.id], ['canvas', 'radial', 40]]);
  expect([drops.rowAccepts, drops.canvasAccepts]).toEqual([true, true]);

  // path target kinds: a registered kind lists its rows in the Paths panel and answers path:delete
  const paths = await page.evaluate(async () => {
    const app = window.pigmentApp;
    const { registerPathTargetKind, setActivePath } = await import('/lib/tools/vector.js');
    const d = app.doc;
    let path = { subpaths: [{ closed: true, points: [{ x: 10, y: 10 }, { x: 60, y: 10 }, { x: 60, y: 60 }] }] };
    const removed = [];
    const target = () => ({ kind: 'test-kind', key: 'test-kind', label: 'Test Path', doc: d, get: () => path, valid: () => true, commit: (p) => (path = p) });
    registerPathTargetKind('test-kind', { fromRef: () => target(), fromActive: () => null, rows: () => [{ key: 'test-kind', ap: { kind: 'test-kind' }, name: 'Test Path', path }], remove: (a, t) => removed.push(t.key) });
    app.panels.show('paths', { reveal: true });
    setActivePath(app, { kind: 'test-kind' });
    await new Promise((res) => requestAnimationFrame(res));
    const row = !!document.querySelector('.path-row[data-key="test-kind"]');
    const enabled = app.commands.isEnabled('path:delete');
    await app.commands.run('path:delete', undefined, 'api');
    return { row, enabled, removed };
  });
  expect(paths).toEqual({ row: true, enabled: true, removed: ['test-kind'] });

  // Free Transform on one of two linked layers moves both; layer:move-to with several ids keeps their order
  const links = await page.evaluate(async () => {
    const app = window.pigmentApp;
    const d = app.doc;
    const make = async (name, x) => {
      await app.commands.run('layer:new', undefined, 'api');
      const l = d.active;
      l.name = name;
      const c = l.canvas.getContext('2d');
      c.fillStyle = '#00f';
      c.fillRect(x, 100, 20, 20);
      l.touch();
      return l;
    };
    const a = await make('A', 10), b = await make('B', 60), c = await make('C', 110);
    d.setActive(a);
    d.setActive(b, { additive: true });
    await app.commands.run('layer:link', undefined, 'api');
    d.setActive(a);
    const tt = app.transformTool;
    tt.start({ mode: 'free' });
    const targets = tt.session.targets.map((l) => l.name).sort();
    tt.cancel();
    const n = d.history.index;
    await app.commands.run('layer:move-to', { ids: [b.id, a.id], target: c.id, mode: 'above' }, 'api');
    return { targets, order: d.root.children.map((l) => l.name), entries: d.history.index - n };
  });
  expect(links.targets).toEqual(['A', 'B']);
  expect(links.order.slice(-3)).toEqual(['C', 'A', 'B']);
  expect(links.entries).toBe(1);

  // merged sampling honours app.sampleSkip; layer double-click actions; icons; rulers
  const misc = await page.evaluate(async () => {
    const app = window.pigmentApp;
    const d = app.doc;
    const { sampleMerged } = await import('/lib/sample.js');
    const top = d.root.children[d.root.children.length - 1];
    const px = (c) => Array.from(c.getContext('2d').getImageData(70, 110, 1, 1).data);
    const shown = px(sampleMerged(app, d));
    app.sampleSkip = () => new Set([top]);
    const skipped = px(sampleMerged(app, d));
    app.sampleSkip = null;
    const hits = [];
    app.registerLayerDoubleClick('raster', (layer) => (hits.push(layer.name), true));
    app.tools.activate('move');
    app.tools.active.onDoubleClick({ x: 70, y: 110 });
    const { registerIcons, icon, ICON_NAMES } = await import('/lib/icons.js');
    registerIcons({ 'test-icon': '<path d="M1 1h2"/>', open: '<path d="M0 0"/>' });
    app.settings.rulerUnit = 'in';
    const inches = app.rulers.format(d, 'x', 144);
    app.settings.rulerUnit = 'px';
    return { shown, skipped, hits, icon: icon('test-icon').includes('M1 1h2'), kept: !icon('open').includes('M0 0'), listed: ICON_NAMES.includes('test-icon'), inches };
  });
  expect(misc.shown).toEqual([0, 0, 255, 255]);
  expect(misc.skipped).not.toEqual(misc.shown);
  expect(misc.hits).toEqual(['B']);
  expect(misc).toMatchObject({ icon: true, kept: true, listed: true });
  if (!has['guides-snapping']) expect(misc.inches).toBe('2 in'); // the rulers stub's format
  expect(errors).toEqual([]);
});

test('preset store, failed settings writes and the clipboard text of the browser bridge', async ({ page }) => {
  const errors = await openApp(page);
  // the 0.4 kinds are registered with 0.3's built-ins; a user gradient persists in IndexedDB across a reload
  const first = await page.evaluate(async () => {
    const app = window.pigmentApp;
    await app.presets.ready('gradients');
    const builtins = app.presets.list('gradients').map((p) => p.name);
    app.presets.add('gradients', { name: 'Kept', data: { stops: [{ pos: 0, color: '#123456' }, { pos: 1, color: '#abcdef' }] } });
    await app.presets.flush();
    return { builtins, kinds: ['patterns', 'contours', 'styles', 'shapes', 'stroke-styles', 'tool-presets'].map((k) => app.presets.list(k).length) };
  });
  // 0.3's built-ins (a package may register more built-ins of its kinds)
  expect(first.builtins).toEqual(expect.arrayContaining(['Foreground to background', 'Foreground to transparent', 'Black to white', 'Spectrum', 'Sunset', 'Ocean', 'Copper', 'Chrome']));
  [0, 1, 0, 8, 3, 0].forEach((n, i) => expect(first.kinds[i]).toBeGreaterThanOrEqual(n));
  await page.reload();
  await page.waitForSelector('body[data-ready]');
  const after = await page.evaluate(async () => {
    const app = window.pigmentApp;
    await app.presets.ready('gradients');
    return app.presets.list('gradients').map((p) => p.name);
  });
  expect(after).toContain('Kept');

  // __pigmentTest.presets replaces IndexedDB: seeded files are read, writes land in it
  const seeded = await page.evaluate(async () => {
    window.__pigmentTest.presets = { files: { 'stroke-styles': { format: 'pigment-presets', version: 1, kind: 'stroke-styles', kindVersion: 1, groups: [], items: [], hidden: ['dotted'] } } };
    const { PresetStore } = await import('/lib/presets.js');
    const { bridge } = await import('/lib/bridge.js');
    const store = new PresetStore({ backend: bridge.presets, delay: 0 });
    await store.ready('stroke-styles');
    const names = store.list('stroke-styles').map((p) => p.name);
    await store.ready('styles');
    store.add('styles', { name: 'Mine', data: { styles: {} } });
    await store.flush();
    store.dispose();
    return { names, written: window.__pigmentTest.presets.files.styles?.format ?? null };
  });
  expect(seeded).toEqual({ names: ['Solid', 'Dashed'], written: 'pigment-presets' });

  // a preset with colour references applied to a Gradient Fill stores hex colours
  await newDoc(page, { width: 60, height: 40 });
  const fill = await page.evaluate(async () => {
    const app = window.pigmentApp;
    app.setColors({ foreground: '#ff0000', background: '#00ff00' });
    const preset = app.presets.get('gradients', 'foreground-to-background');
    const refs = preset.data.stops.map((s) => s.color);
    await app.commands.run('layer:new-fill', { kind: 'gradient', paint: { type: 'gradient', gradient: preset.data } }, 'api');
    return { refs, stored: app.doc.active.paint.gradient.stops.map((s) => s.color) };
  });
  expect(fill).toEqual({ refs: [{ ref: 'fg' }, { ref: 'bg' }], stored: ['#ff0000', '#00ff00'] });

  // a failed preset write is reported once; the in-memory state stays
  const failedPresets = await page.evaluate(async () => {
    const app = window.pigmentApp;
    window.__pigmentTest.failPresetWrite = 'quota';
    const events = [];
    const off = app.on('settings:write-failed', (e) => events.push(`${e.area}:${e.code}`));
    await app.presets.ready('contours');
    app.presets.add('contours', { name: 'Bumpy', data: { points: [{ x: 0, y: 0 }, { x: 1, y: 0.5 }] } });
    await app.presets.flush();
    off();
    window.__pigmentTest.failPresetWrite = null;
    return { events, kept: app.presets.list('contours').some((p) => p.name === 'Bumpy') };
  });
  expect(failedPresets.events[0]).toBe('presets:storage-quota');
  expect(failedPresets.kept).toBe(true);

  // failSettingsWrite = 'quota': two writes, one toast; the session keeps the setting
  const settings = await page.evaluate(async () => {
    const app = window.pigmentApp;
    window.__pigmentTest.failSettingsWrite = 'quota';
    const events = [];
    const off = app.on('settings:write-failed', (e) => events.push(`${e.area}:${e.code}`));
    const before = document.querySelectorAll('.toast.error').length;
    await app.saveSettings({ gridSize: 33 });
    await app.saveSettings({ gridSize: 34 });
    off();
    window.__pigmentTest.failSettingsWrite = null;
    return { events, toasts: document.querySelectorAll('.toast.error').length - before, text: [...document.querySelectorAll('.toast.error')].pop()?.textContent, gridSize: app.settings.gridSize };
  });
  expect(settings.events).toEqual(['settings:storage-quota', 'settings:storage-quota']);
  expect(settings.toasts).toBe(1);
  expect(settings.text).toContain('Settings could not be saved (the browser storage is full)');
  expect(settings.gridSize).toBe(34);

  // bridge.readClipboardText() gives __pigmentTest.clipboardText
  expect(await page.evaluate(async () => {
    window.__pigmentTest.clipboardText = 'from the spec';
    return window.pigmentApp.bridge.readClipboardText();
  })).toBe('from the spec');
  expect(errors.filter((e) => !/Could not save/.test(e))).toEqual([]);
});

// ---- step 10: menus, keys, stubs, modules --------------------------------------------------------------------------

// M.7: the ids the skeleton stubs (disabled, in app.stubbed) until their package lands; a landed package registers them
// without `stub` (rule 4), so the check is: each id is either a disabled stub in app.stubbed or a real registration
const DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
const BLENDS = ['normal', 'dissolve', 'darken', 'multiply', 'color-burn', 'linear-burn', 'lighten', 'screen', 'color-dodge', 'linear-dodge', 'overlay', 'soft-light', 'hard-light', 'vivid-light', 'linear-light', 'pin-light', 'hard-mix', 'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity', 'pass-through'];
const TYPE_IDS = ['size-up', 'size-down', 'size-up-10', 'size-down-10', 'leading-down', 'leading-up', 'leading-down-10', 'leading-up-10', 'kern-down', 'kern-up', 'kern-down-100', 'kern-up-100', 'baseline-up', 'baseline-down', 'baseline-up-10', 'baseline-down-10', 'align-left', 'align-center', 'align-right', 'align-justify-left', 'align-justify-all', 'toggle-faux-bold', 'toggle-faux-italic', 'toggle-underline', 'toggle-strike', 'toggle-all-caps', 'toggle-small-caps', 'toggle-superscript', 'toggle-subscript', 'reset-scale-x', 'reset-scale-y', 'auto-leading', 'reset-tracking', 'toggle-hyphenation', 'toggle-composer', 'hide-selection'].map((s) => `type:${s}`);
const M7_STUBS = [
  'window:panel-paragraph', 'type:reset-character', 'type:reset-paragraph', 'type:hyphenation-settings', 'type:justification-settings', ...TYPE_IDS,
  'edit:paste-without-formatting', 'edit:toggle-last-state', 'edit:search', 'edit:menus',
  'image:adjust-levels-last', 'image:adjust-curves-last', 'image:adjust-hue-saturation-last', 'image:adjust-color-balance-last',
  'layer:style-create-layers', 'layer:style-toggle-all', 'layer:style-scale',
  'layer:vector-mask', 'layer:mask-overlay', 'layer:mask-overlay-options', 'path:make-mask', 'path:make-shape',
  'layer:copy-shape-attributes', 'layer:paste-shape-attributes', 'layer:collapse-all-groups', 'layer:panel-options',
  'layer:merge-group', 'layer:arrange-reverse', 'layer:lock-dialog', 'layer:lock-group', 'layer:select-similar', 'layer:new-no-dialog',
  'layer:stamp-visible', 'layer:stamp-selected', 'layer:select-forward', 'layer:select-backward', 'layer:select-front', 'layer:select-back',
  'layer:select-add-forward', 'layer:select-add-backward', 'layer:lock-transparency-toggle',
  ...DIGITS.map((d) => `layer:opacity-digit-${d}`), ...DIGITS.map((d) => `layer:fill-digit-${d}`), ...BLENDS.map((b) => `layer:blend-mode-${b}`),
  'layer:blend-next', 'layer:blend-prev',
  'view:smart-guides', 'view:snap-to', 'view:lock-guides', 'view:clear-artboard-guides', 'view:clear-selected-guides', 'view:new-guide-layout',
  'view:guides-from-shape', 'view:edit-selected-guides', 'view:ruler-unit', 'view:ruler-origin-reset', 'view:pattern-preview',
  'window:panel-gradients', 'window:panel-patterns',
];

test('menus, keys and stubs: every template command exists, every M.7 stub is disabled, layer:merge and type:toggle-panels work', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 120, height: 80 });
  // every command the template names (with a document, a layer, a selection, a text layer, a vector mask)
  const ids = new Set();
  const walk = (items) => {
    for (const it of items) {
      if (it.submenu) walk(it.submenu);
      else if (it.click) it.click(it, null, undefined);
    }
  };
  for (const platform of ['linux', 'darwin']) {
    walk(buildMenuTemplate({ platform, state: { hasDocument: true, hasLayer: true, hasSelection: true, layerType: 'text', hasVectorMask: true, showGalleryInMenu: true }, recent: [], run: (c) => ids.add(c), isPackaged: false }));
  }
  const info = await page.evaluate(async ({ list, stubs }) => {
    const app = window.pigmentApp;
    const flag = (id, k) => app.commands.commands.get(id)?.[k];
    const { ADJUSTMENTS } = await import('/shared/pixels/adjust.js');
    return {
      missing: list.filter((id) => !app.commands.has(id)),
      // neither a stub (in app.stubbed, marked stub) nor a real registration (not in app.stubbed, not marked stub)
      unaccounted: stubs.filter((id) => !app.commands.has(id) || app.stubbed.includes(id) !== !!flag(id, 'stub')),
      // rule 4: every id still stubbed is disabled (the M.7 ones and any other)
      enabled: app.stubbed.filter((id) => app.commands.isEnabled(id)),
      // the placeholder kinds stay disabled until adjust-color drops `placeholder` (then they are enabled)
      placeholders: ['color-vibrance', 'clarity-dehaze', 'grain'].map((k) => [app.commands.has(`image:adjust-${k}`), app.commands.isEnabled(`image:adjust-${k}`) === !ADJUSTMENTS[k]?.placeholder]),
      working: ['type:toggle-panels', 'layer:merge'].map((id) => [app.commands.has(id), app.stubbed.includes(id), !!flag(id, 'stub')]),
      guidePlaceholders: ['view:new-guide', 'view:clear-guides'].map((id) => [app.stubbed.includes(id), !!flag(id, 'changesDocument')]),
      flags: [flag('edit:toggle-last-state', 'undoLike'), flag('edit:search', 'record'), flag('layer:collapse-all-groups', 'record'), flag('layer:panel-options', 'record'), flag('view:ruler-origin-reset', 'changesDocument'), flag('view:clear-selected-guides', 'changesDocument')],
      uiState: ['selectedCount', 'effectsHidden', 'hasVectorMask', 'vectorMaskEnabled', 'typeEditing', 'smartGuides', 'lockGuides', 'snapTo', 'patternPreview'].map((k) => [k, app.uiState[k]]),
      settings: { type: app.settings.type, guides: app.settings.guides.snapTo, layersPanel: app.settings.layersPanel.thumbSize, conventions: app.settings.conventions.springLoaded, patterns: app.settings.patterns.current },
    };
  }, { list: [...ids], stubs: M7_STUBS });
  expect(ids.size).toBeGreaterThan(300);
  expect(info.missing).toEqual([]);
  expect(info.unaccounted).toEqual([]);
  expect(info.enabled).toEqual([]);
  expect(info.placeholders).toEqual([[true, true], [true, true], [true, true]]);
  expect(info.working).toEqual([[true, false, false], [true, false, false]]);
  expect(info.guidePlaceholders).toEqual([[false, true], [false, true]]);
  expect(info.flags).toEqual([true, false, false, false, true, true]);
  expect(Object.fromEntries(info.uiState)).toEqual({ selectedCount: 1, effectsHidden: false, hasVectorMask: false, vectorMaskEnabled: false, typeEditing: false, smartGuides: true, lockGuides: false, snapTo: 'guides,grid,layers,bounds,artboards,slices', patternPreview: false });
  expect(info.settings).toEqual({ type: { unit: 'px', char: {}, para: {}, placeholder: true }, guides: { guides: true, grid: true, layers: true, bounds: true, artboards: true, slices: true }, layersPanel: 'medium', conventions: true, patterns: null });

  // layer:merge (Ctrl+E) merges down, reported as layer:merge-down (what an action records); merge-down keeps its meaning
  const before = await page.evaluate(async () => {
    const app = window.pigmentApp;
    await app.commands.run('layer:new', undefined, 'api');
    await app.commands.run('layer:new', undefined, 'api');
    window.__done = [];
    app.on('command:done', (e) => window.__done.push({ id: e.id, replayId: e.replayId ?? null, source: e.source }));
    return app.doc.layers().length;
  });
  await page.locator('canvas.view').click({ position: { x: 5, y: 5 } }).catch(() => {});
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+e');
  await expect.poll(() => page.evaluate(() => window.pigmentApp.doc.layers().length)).toBe(before - 1);
  expect(await page.evaluate(() => window.__done.filter((e) => e.id === 'layer:merge'))).toEqual([{ id: 'layer:merge', replayId: 'layer:merge-down', source: 'key' }]);

  // Layer > Distribute's edge arguments answer "Not available yet" instead of 0.3's horizontal default (until
  // finish-layer-menu delivers the full submenu)
  const has = await landed(page);
  const distributed = has['finish-layer-menu'] ? null : await page.evaluate(async () => {
    const app = window.pigmentApp;
    const { RasterLayer, createCanvas } = await import('/lib/document.js');
    const d = app.doc;
    const made = [0, 30, 90].map((x) => {
      const c = createCanvas(10, 10);
      c.getContext('2d').fillRect(0, 0, 10, 10);
      const l = new RasterLayer({ name: `D${x}`, canvas: c, x, y: x / 3 });
      d.add(l);
      return l;
    });
    d.selected.clear();
    for (const l of made) d.selected.add(l);
    d.setActive(made[2]);
    for (const l of made) d.selected.add(l);
    const before = made.map((l) => [l.x, l.y]);
    await app.commands.run('layer:distribute', 'top', 'api');
    const after = made.map((l) => [d.find(l.id).x, d.find(l.id).y]);
    return { before, after, toast: document.querySelector('.toast')?.textContent ?? '' };
  });
  if (distributed) {
    expect(distributed.after).toEqual(distributed.before);
    expect(distributed.toast).toContain('Not available yet');
  }

  // type:toggle-panels shows the Character panel (and the Paragraph panel once type-paragraph-panel has landed)
  await runAwait(page, 'type:toggle-panels');
  // (both sit in the middle group: the one shown last is the visible tab)
  await expect.poll(() => page.evaluate(() => ['character', 'paragraph'].some((id) => window.pigmentApp.panels.isVisible(id)))).toBe(true);

  // the menu command source (M.1, O): the bridge's third value picks 'menu-key', 'menu' or 'key'
  const sources = await page.evaluate(() => {
    const app = window.pigmentApp;
    const seen = [];
    const off = app.commands.observe({ before: (id, arg, source) => (id === 'view:zoom-in' ? seen.push(source) : null), after: () => {} });
    app.bridge.__emit('command', 'view:zoom-in', undefined, true);
    app.bridge.__emit('command', 'view:zoom-in', undefined, false);
    app.bridge.__emit('command', 'view:zoom-in', undefined, 'key');
    app.bridge.__emit('command', 'view:zoom-in');
    // a key main.js took is dropped while a text field has focus, as shortcuts.js drops it on the page
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    app.bridge.__emit('command', 'view:zoom-in', undefined, 'key');
    // also while the focused field belongs to a session that owns focus (the type editor's input: isTextTarget() is
    // false for it)
    const end = app.sessions.begin({ id: 'test-owns-focus', policy: 'observe', ownsFocus: (el) => el === input });
    const owned = app.isTextTarget(input);
    app.bridge.__emit('command', 'view:zoom-in', undefined, 'key');
    end.end();
    input.remove();
    off();
    return [...seen, owned];
  });
  expect(sources).toEqual(['menu-key', 'menu', 'key', 'menu', false]);
  expect(errors).toEqual([]);
});

test('a version 2 .pigment with text, guides, a gradient fill, a Gradient Map and a styled layer opens and renders as 0.3 did', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 120, height: 60 });
  const r = await page.evaluate(async () => {
    const { RasterLayer, FillLayer, AdjustmentLayer, TextLayer, createCanvas } = await import('/lib/document.js');
    const { writePigment, readPigment } = await import('/lib/io.js');
    const { readZip, writeZip, findEntry, streamCodecs } = await import('/shared/zip.js');
    const { applyAdjustment } = await import('/shared/pixels/adjust.js');
    const { Compositor } = await import('/lib/compositor.js');
    const { setEngine } = await import('/lib/type/api.js');
    const M = await import('/lib/type/model.js');
    setEngine('canvas');
    const app = window.pigmentApp;
    const src = app.doc;
    const W = src.width, H = src.height;
    // build the layers with the 0.4 classes, then write document.json the way Pigment 0.3 wrote it
    for (const l of src.layers()) src.remove(l);
    src.add(new FillLayer({ name: 'Gradient', paint: { type: 'gradient', gradient: { kind: 'linear', stops: [{ pos: 0, color: '#ff0000' }, { pos: 1, color: '#0000ff' }] } }, docWidth: W, docHeight: H }));
    const gm03 = { stops: [{ offset: 0, color: '#000000' }, { offset: 1, color: '#ffffff' }], reverse: false };
    src.add(new AdjustmentLayer({ name: 'Map', kind: 'gradient-map', params: gm03 }));
    const sq = createCanvas(20, 20);
    sq.getContext('2d').fillRect(0, 0, 20, 20);
    const styled = new RasterLayer({ name: 'Styled', canvas: sq, x: 10, y: 10 });
    styled.styles = { colorOverlay: { enabled: true, color: '#00ff00', opacity: 1, blend: 'normal' } };
    src.add(styled);
    src.add(new TextLayer({ text: 'Hi there', font: { family: 'sans-serif', size: 20, color: '#ff00ff', weight: 700 }, x: 50, y: 10 }));
    src.guides = [{ axis: 'x', pos: 30 }, { axis: 'y', pos: 15 }];
    const entries = await readZip(await writePigment(src), { inflate: streamCodecs.inflate });
    const entry = findEntry(entries, 'document.json');
    const json = JSON.parse(new TextDecoder().decode(entry.data));
    json.version = 2;
    delete json.store;
    json.guides = [{ axis: 'x', pos: 30 }, { axis: 'y', pos: 15 }];
    const strip = (d) => {
      delete d.vectorMask;
      delete d.blending;
      if (d.type === 'text') {
        delete d.content;
        delete d.typeOptions;
        delete d.height;
      }
      for (const c of d.children ?? []) strip(c);
    };
    for (const d of json.layers ?? json.root?.children ?? []) strip(d);
    const textDesc = (json.layers ?? json.root?.children ?? []).find((d) => d.type === 'text');
    entry.data = new TextEncoder().encode(JSON.stringify(json));
    const bytes = await writeZip(entries.map((e) => ({ name: e.name, data: e.data })), { deflate: streamCodecs.deflate });
    const doc = await readPigment(bytes);
    const out = new Compositor().composite(doc).getContext('2d').getImageData(0, 0, W, H).data;
    const px = (x, y) => Array.from(out.slice((y * W + x) * 4, (y * W + x) * 4 + 4));
    // expected: 0.3's Canvas gradient (makeGradient) under 0.3's Gradient Map, the overlay colour, the text colour
    const ref = createCanvas(W, H).getContext('2d');
    const g = ref.createLinearGradient(0, H / 2, W, H / 2);
    g.addColorStop(0, '#ff0000ff');
    g.addColorStop(1, '#0000ffff');
    ref.fillStyle = g;
    ref.fillRect(0, 0, W, H);
    const mapped = (x, y) => {
      const img = ref.getImageData(x, y, 1, 1);
      applyAdjustment(img, 'gradient-map', gm03);
      return Array.from(img.data);
    };
    const text = doc.layers().find((l) => l.type === 'text');
    const tr = text.render();
    const tw = tr.canvas.width, th = tr.canvas.height;
    const td = tr.canvas.getContext('2d').getImageData(0, 0, tw, th).data;
    let ink = null;
    for (let i = 3; i < td.length && !ink; i += 4) if (td[i] === 255) ink = [((i - 3) / 4) % tw + tr.x, Math.floor((i - 3) / 4 / tw) + tr.y];
    const para = M.paraAttrs(text.content, 0, M.plainText(text.content).length);
    return {
      textDesc: Object.keys(textDesc).includes('content'),
      version: json.version,
      guides: doc.guides.map((x) => ({ axis: x.axis, pos: x.pos, id: typeof x.id })),
      left: [px(2, 40), mapped(2, 40)],
      mid: [px(60, 50), mapped(60, 50)],
      right: [px(W - 3, 40), mapped(W - 3, 40)],
      overlay: px(20, 20),
      ink: ink ? px(ink[0], ink[1]) : null,
      text: { text: text.text, composer: para.composer, breakRules: para.breakRules, fill: doc.layers().find((l) => l.type === 'fill').paint.type },
    };
  });
  expect(r.textDesc).toBe(false);
  expect(r.guides).toEqual([{ axis: 'x', pos: 30, id: 'string' }, { axis: 'y', pos: 15, id: 'string' }]);
  for (const [got, want] of [r.left, r.mid, r.right]) {
    expect(got[0]).toBe(got[1]); // grey: the Gradient Map of the gradient below
    for (let i = 0; i < 4; i++) expect(Math.abs(got[i] - want[i])).toBeLessThanOrEqual(1);
  }
  expect(r.left[0][0]).not.toBe(r.right[0][0]);
  expect(r.overlay).toEqual([0, 255, 0, 255]);
  expect(r.ink).toEqual([255, 0, 255, 255]);
  expect(r.text).toEqual({ text: 'Hi there', composer: 'single', breakRules: 'legacy', fill: 'gradient' });
  expect(errors).toEqual([]);
});

test('a version 3 round trip: two text runs, a vector mask with initialFill, blending, mask density, coloured guides, an unknown collection', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 100, height: 80 });
  const r = await page.evaluate(async () => {
    const { RasterLayer, TextLayer, createCanvas } = await import('/lib/document.js');
    const { writePigment, readPigment } = await import('/lib/io.js');
    const M = await import('/lib/type/model.js');
    const d = window.pigmentApp.doc;
    let content = M.fromPlain('Two runs', { size: 24, color: '#ff0000' });
    content = M.applyChar(content, 4, 8, { color: '#0000ff', fontWeight: 700 });
    d.add(new TextLayer({ content, x: 5, y: 5 }));
    const c = createCanvas(30, 30);
    c.getContext('2d').fillRect(0, 0, 30, 30);
    const mask = createCanvas(d.width, d.height);
    const layer = new RasterLayer({ name: 'Masked', canvas: c, x: 10, y: 40, blending: { knockout: 'deep', blendIf: { gray: { this: [10, 10, 245, 245] } } },
      vectorMask: { path: { subpaths: [{ closed: true, points: [{ x: 10, y: 40 }, { x: 40, y: 40 }, { x: 40, y: 70 }] }] }, initialFill: 'hide' } });
    layer.mask = { canvas: mask, enabled: true, linked: true, density: 0.25, feather: 3 };
    d.add(layer);
    d.store.add('guides', { axis: 'y', pos: 33, color: '#00ff00' }, { label: 'New Guide' });
    d.store.raw.set('slices', { v: 1, data: [{ id: 's1', rect: [0, 0, 10, 10] }] });
    const back = await readPigment(await writePigment(d));
    const t = back.layers().find((l) => l.type === 'text');
    const m = back.layers().find((l) => l.name === 'Masked');
    return {
      runs: M.runsIn(t.content).map((run) => [M.plainText(t.content).slice(run.from, run.to), run.style.color ?? null, run.style.fontWeight ?? null]),
      equal: JSON.stringify(t.content) === JSON.stringify(content),
      vectorMask: m.vectorMask,
      blending: m.blending,
      mask: [m.mask.density, m.mask.feather, m.mask.enabled],
      guides: back.guides.map((g) => ({ ...g })),
      ids: [d.guides[0].id, back.guides[0].id],
      slices: back.store.toJSON().slices,
    };
  });
  expect(r.equal).toBe(true);
  expect(r.runs.length).toBe(2);
  expect(r.runs[0][1]).toBe('#ff0000');
  expect(r.runs[1]).toEqual(['runs', '#0000ff', 700]);
  expect(r.vectorMask).toMatchObject({ enabled: true, linked: true, density: 1, feather: 0, initialFill: 'hide' });
  expect(r.vectorMask.path.subpaths[0].points[1]).toEqual({ x: 40, y: 40 });
  expect(r.blending).toEqual({ knockout: 'deep', blendIf: { gray: { this: [10, 10, 245, 245] } } });
  expect(r.mask).toEqual([0.25, 3, true]);
  expect(r.guides).toMatchObject([{ axis: 'y', pos: 33, color: '#00ff00' }]);
  expect(r.ids[0]).toBe(r.ids[1]);
  expect(r.slices).toEqual({ v: 1, data: [{ id: 's1', rect: [0, 0, 10, 10] }] });
  expect(errors).toEqual([]);
});

test('adjustment margin: a kind keyed on ctx.origin with margin 4 gives the same pixels in a full and a partial composite', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 64, height: 40 });
  const r = await page.evaluate(async () => {
    const { RasterLayer, AdjustmentLayer, createCanvas } = await import('/lib/document.js');
    const { registerTestAdjustment } = await import('/shared/pixels/adjust.js');
    const { Compositor } = await import('/lib/compositor.js');
    const d = window.pigmentApp.doc;
    // stripes below, so a neighbourhood kind sees different pixels near any edge of a sub-rectangle
    const c = createCanvas(d.width, d.height);
    const cx = c.getContext('2d');
    for (let x = 0; x < d.width; x++) {
      cx.fillStyle = `rgb(${(x * 37) % 256}, 0, ${(x * 11) % 256})`;
      cx.fillRect(x, 0, 1, d.height);
    }
    const stripes = new RasterLayer({ name: 'Stripes', canvas: c, x: 0, y: 0 });
    d.add(stripes);
    d.setActive(stripes); // the adjustment layer goes above it
    let margin = 4;
    // red: the maximum over x-4..x+4 (needs the margin); green: a pattern of the document position (needs ctx.origin)
    registerTestAdjustment('test-margin', {
      name: 'Test margin',
      defaults: {},
      margin: () => margin,
      apply(img, params, rect, ctx) {
        const { width: w, height: h, data } = img;
        const src = new Uint8ClampedArray(data);
        const ox = ctx?.origin?.x ?? 0, oy = ctx?.origin?.y ?? 0;
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            let m = 0;
            for (let k = Math.max(0, x - 4); k <= Math.min(w - 1, x + 4); k++) m = Math.max(m, src[(y * w + k) * 4]);
            const i = (y * w + x) * 4;
            data[i] = m;
            data[i + 1] = ((x + ox) * 7 + (y + oy) * 3) % 256;
          }
        }
        return img;
      },
    });
    try {
      d.add(new AdjustmentLayer({ name: 'Test', kind: 'test-margin', params: {} }));
      const rect = { x: 17, y: 9, width: 21, height: 13 };
      const read = (canvas, x, y, w, h) => Array.from(canvas.getContext('2d').getImageData(x, y, w, h).data);
      const full = read(new Compositor().composite(d), rect.x, rect.y, rect.width, rect.height);
      const part = read(new Compositor().composite(d, { rect }), 0, 0, rect.width, rect.height);
      // without the margin the edges of the sub-rectangle see fewer neighbours: the growth is what makes them equal
      margin = 0;
      const bare = read(new Compositor().composite(d, { rect }), 0, 0, rect.width, rect.height);
      let diff = 0, bareDiff = 0;
      for (let i = 0; i < full.length; i++) {
        diff = Math.max(diff, Math.abs(full[i] - part[i]));
        bareDiff = Math.max(bareDiff, Math.abs(full[i] - bare[i]));
      }
      return { diff, bareDiff, n: full.length, top: d.layers().at(-1).kind };
    } finally {
      registerTestAdjustment('test-margin', null);
    }
  });
  expect(r.n).toBe(21 * 13 * 4);
  expect(r.diff).toBe(0);
  expect(r.top).toBe('test-margin');
  expect(r.bareDiff).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});
