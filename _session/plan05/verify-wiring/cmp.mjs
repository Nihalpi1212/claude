// Builds 0.4 documents in a 0.4.0 copy (port 8875), saves them as .pigment, opens them in the working tree (8874) and
// in 0.4.0 again, compares flattened pixels and layer descriptions.
import { chromium } from '/home/user/claude/pigment/node_modules/playwright-core/index.mjs';
import { spawn } from 'node:child_process';
const V04 = process.env.V04;
const s05 = spawn('node', ['/home/user/claude/pigment/tests/e2e/server.mjs', '8874'], { stdio: 'ignore' });
const s04 = spawn('node', [`${V04}/tests/e2e/server.mjs`, '8875'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 800));
const browser = await chromium.launch();
process.on('exit', () => { s05.kill(); s04.kill(); });
process.on('uncaughtException', (e) => { console.error(e); s05.kill(); s04.kill(); process.exit(1); });
async function open(port, init) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  const logs = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${port} ${m.type()}] ${m.text()}`); });
  page.on('pageerror', (e) => logs.push(`[${port} pageerror] ${e.message}`));
  if (init) await page.addInitScript(init[0], init[1]);
  await page.goto(`http://127.0.0.1:${port}/index.html`);
  await page.waitForSelector('body[data-ready]', { timeout: 20000 });
  return { page, logs };
}
const BRUSH_PRESETS = [{ id: 'user-1', name: 'My Soft 33', size: 33, hardness: 0.3, spacing: 0.25, angle: 20, roundness: 0.6, flow: 0.7 }];
const init = (presets) => {
  try { const s = JSON.parse(localStorage.getItem('pigment.settings') || '{}'); s.brushPresets = presets; localStorage.setItem('pigment.settings', JSON.stringify(s)); } catch {}
};
const a = await open(8875, [init, BRUSH_PRESETS]);
const build = async () => {
  const app = window.pigmentApp;
  const { RasterLayer, TextLayer, createCanvas } = await import('/lib/document.js');
  const { structural } = await import('/lib/layer-ops.js');
  const M = await import('/lib/type/model.js');
  const { writePigment, readPigment } = await import('/lib/io.js');
  const { flattenDocument } = await import('/lib/compositor.js');
  const fill = (w, h, color, rect = null) => { const c = createCanvas(w, h); const x = c.getContext('2d'); x.fillStyle = color; if (rect) x.fillRect(rect.x, rect.y, rect.width, rect.height); else x.fillRect(0, 0, w, h); return c; };
  const add = (layer) => structural(app, 'Add', () => { app.doc.add(layer); app.doc.setActive(layer); });
  const out = {};
  const docs = {
    text: async () => {
      const l1 = new TextLayer({ content: M.fromPlain('Golden 0.4', { size: 24, color: '#202060', fontWeight: 700 }, {}), x: 10, y: 30 }); l1.name = 'Point';
      const l2 = new TextLayer({ content: M.fromPlain('Box text that wraps over lines', { size: 14, tracking: 50 }, { align: 'center' }), x: 10, y: 50, width: 120 }); l2.name = 'Box';
      add(l1); add(l2);
    },
    guides: async () => {
      add(new RasterLayer({ name: 'Layer', canvas: fill(40, 40, '#808080'), x: 20, y: 20 }));
      app.doc.store.add('guides', { axis: 'x', pos: 30 }, { label: 'New Guide' });
      app.doc.store.add('guides', { axis: 'y', pos: 45.5, color: '#ff8800' }, { label: 'New Guide' });
    },
    styles: async () => {
      add(new RasterLayer({ name: 'Styled', canvas: fill(60, 40, '#20a020'), x: 30, y: 25, styles: { dropShadow: { enabled: true, distance: 5, size: 4 }, stroke: { enabled: true, size: 3, color: '#ff00ff' }, bevel: { enabled: true } } }));
      add(new RasterLayer({ name: 'BlendIf', canvas: fill(160, 120, '#e0e0e0'), x: 0, y: 0, opacity: 0.8, blend: 'multiply', blending: { blendIf: { gray: { this: [0, 0, 200, 230], under: [30, 60, 255, 255] } } } }));
    },
    fills: async () => {
      add(new RasterLayer({ name: 'Base', canvas: fill(160, 120, '#ffffff'), x: 0, y: 0 }));
      await app.commands.run('layer:new-fill', { kind: 'gradient', paint: { type: 'gradient', gradient: { gradientVersion: 2, type: 'solid', interpolation: 'classic', smoothness: 1, stops: [{ pos: 0, mid: 0.5, color: '#ff0000' }, { pos: 1, mid: 0.5, color: '#0000ff' }], opacityStops: [{ pos: 0, mid: 0.5, opacity: 1 }, { pos: 1, mid: 0.4, opacity: 0.3 }], kind: 'linear', from: [10, 10], to: [150, 100] } } }, 'api');
      await app.commands.run('layer:new-fill', { kind: 'solid', paint: { type: 'solid', color: '#123456' } }, 'api');
      app.doc.active.opacity = 0.4; app.doc.active.blend = 'screen'; app.doc.active.touch?.();
      const cur = app.patterns?.current?.() ?? app.presets?.list?.('patterns')?.[0];
      if (cur) { const { makePatternPaint } = await import('/lib/pattern-picker.js').catch(() => ({})); }
    },
    smart: async () => {
      const c = fill(160, 120, '#ffffff'); const x = c.getContext('2d'); x.fillStyle = '#c03030'; x.fillRect(30, 30, 80, 50);
      add(new RasterLayer({ name: 'Smart', canvas: c, x: 0, y: 0 }));
      await app.commands.run('layer:smart-convert', undefined, 'api');
      await app.commands.run('filter:gaussian-blur', { radius: 4 }, 'api');
      await app.commands.run('image:adjust-hue-saturation', { hue: 40, saturation: 10, lightness: 0 }, 'api');
      await app.commands.run('filter:camera-raw', { exposure: 0.5, contrast: 20, clarity: 10 }, 'api');
    },
    shapes: async () => {
      const { ShapeLayer } = await import('/lib/document.js');
      await app.commands.run('layer:new-fill', { kind: 'solid', paint: { type: 'solid', color: '#3366cc' } }, 'api').catch(() => {});
      try { add(new ShapeLayer({ name: 'Rect', path: { subpaths: [{ closed: true, points: [[20,20],[90,20],[90,70],[20,70]].map(([x,y]) => ({ x, y, anchor: { x, y }, in: { x, y }, out: { x, y } })) }] }, fill: { type: 'solid', color: '#ff8800' }, stroke: { enabled: true, width: 3, color: '#000000' } })); } catch (e) { console.warn('shape', e.message); }
      const tv = new TextLayer({ content: M.fromPlain('Vert', { size: 18, color: '#008800' }, {}), x: 130, y: 10, typeOptions: { orientation: 'vertical' } }); tv.name = 'Vertical'; add(tv);
      await app.commands.run('layer:new-adjustment', { kind: 'levels', params: { rgb: { inBlack: 20, inWhite: 220, gamma: 1.2, outBlack: 0, outWhite: 255 } } }, 'api');
      add(new RasterLayer({ name: 'Masked', canvas: fill(160, 120, '#ff0000'), x: 0, y: 0, mask: { canvas: fill(160, 120, '#ffffff', { x: 0, y: 0, width: 60, height: 120 }), enabled: true, linked: true } }));
      const rp = (x0, y0, w, h) => ({ subpaths: [{ closed: true, points: [[x0, y0], [x0 + w, y0], [x0 + w, y0 + h], [x0, y0 + h]].map(([px, py]) => ({ x: px, y: py, anchor: { x: px, y: py }, in: { x: px, y: py }, out: { x: px, y: py } })) }] });
      await app.commands.run('layer:vector-mask', { op: 'current-path', path: rp(10, 10, 100, 60) }, 'api');
    },
  };
  for (const [name, fn] of Object.entries(docs)) {
    app.newDocument({ width: 160, height: 120, name });
    try { await fn(); } catch (e) { out[name] = { error: String(e) }; continue; }
    await new Promise((r) => setTimeout(r, 300));
    const d = app.doc;
    const bytes = await writePigment(d);
    const flat = flattenDocument(d).getContext('2d').getImageData(0, 0, d.width, d.height).data;
    out[name] = { bytes: Array.from(bytes), flat: Array.from(flat), layers: d.layers().map((l) => `${l.type}:${l.name}`), guides: JSON.stringify(d.store?.data?.get?.('guides') ?? null), desc: JSON.stringify(d.layers().map((l) => { const { canvas, ...r } = l.describe?.() ?? {}; return r; })) };
  }
  out.brushPresets = app.settings.brushPresets;
  return out;
};
const made = await a.page.evaluate(build);
const readBack = async ({ docs }) => {
  const { readPigment, writePigment } = await import('/lib/io.js');
  const { flattenDocument } = await import('/lib/compositor.js');
  const res = {};
  for (const [name, d0] of Object.entries(docs)) {
    if (d0.error) { res[name] = { error: d0.error }; continue; }
    try {
      const doc = await readPigment(new Uint8Array(d0.bytes));
      window.pigmentApp.docs.add?.(doc);
      await new Promise((r) => setTimeout(r, 400));
      const flat = flattenDocument(doc).getContext('2d').getImageData(0, 0, doc.width, doc.height).data;
      let diff = 0, n = 0;
      for (let i = 0; i < flat.length; i++) { const dd = Math.abs(flat[i] - d0.flat[i]); if (dd > diff) diff = dd; if (dd) n++; }
      const re = await writePigment(doc);
      res[name] = { maxDiff: diff, nDiff: n, layers: doc.layers().map((l) => `${l.type}:${l.name}`), guides: JSON.stringify(doc.store?.data?.get?.('guides') ?? null), desc: JSON.stringify(doc.layers().map((l) => { const { canvas, ...r } = l.describe?.() ?? {}; return r; })), reBytes: Array.from(re) };
    } catch (e) { res[name] = { error: String(e.stack || e) }; }
  }
  return res;
};
const b = await open(8874, [init, BRUSH_PRESETS]);
const in05 = await b.page.evaluate(readBack, { docs: made });
const c = await open(8875);
const in04 = await c.page.evaluate(readBack, { docs: made });
// a 0.5-written file read back by 0.4
const back = Object.fromEntries(Object.entries(in05).filter(([, v]) => v.reBytes).map(([k, v]) => [k, { bytes: v.reBytes, flat: made[k].flat }]));
const in04from05 = await c.page.evaluate(readBack, { docs: back });
const strip = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v.error ? v.error.slice(0,200) : `max ${v.maxDiff} n ${v.nDiff} ${v.layers?.join(',')}`]));
const cmpDesc = (A, B) => Object.fromEntries(Object.keys(A).filter((k) => A[k].desc && B[k]?.desc).map((k) => [k, { guides: A[k].guides === B[k].guides ? 'same' : [A[k].guides, B[k].guides], desc: A[k].desc === B[k].desc ? 'same' : 'DIFF' }]));
console.log('desc 0.5 vs 0.4 (reading 0.4 files)', JSON.stringify(cmpDesc(in05, in04)));
console.log('desc 0.4 read of 0.5 rewrite vs 0.4 read', JSON.stringify(cmpDesc(in04from05, in04)));
for (const k of Object.keys(in05)) if (in05[k].desc && in04[k]?.desc && in05[k].desc !== in04[k].desc) { console.log('DESC', k, '\n05', in05[k].desc.slice(0, 3000), '\n04', in04[k].desc.slice(0, 3000)); }
console.log('rewrite bytes 0.5 vs 0.4 equal', JSON.stringify(Object.fromEntries(Object.keys(in05).filter((k) => in05[k].reBytes).map((k) => [k, JSON.stringify(in05[k].reBytes) === JSON.stringify(in04[k].reBytes)]))));
console.log('smart desc', in05.smart?.desc?.slice(0, 600));
import('node:fs').then((fs) => fs.writeFileSync('rewrites.json', JSON.stringify({ in05: Object.fromEntries(Object.entries(in05).map(([k,v]) => [k, v.reBytes])), in04: Object.fromEntries(Object.entries(in04).map(([k,v]) => [k, v.reBytes])), orig: Object.fromEntries(Object.entries(made).filter(([k]) => k !== 'brushPresets').map(([k,v]) => [k, v.bytes])) })));
console.log('built in 0.4', Object.fromEntries(Object.entries(made).filter(([k]) => k !== 'brushPresets').map(([k, v]) => [k, v.error ?? v.layers.join(', ') + ' guides=' + v.guides])));
console.log('0.5 reads 0.4', strip(in05));
console.log('0.4 reads 0.4', strip(in04));
console.log('0.4 reads 0.5-rewritten', strip(in04from05));
const brushes = await b.page.evaluate(async () => { await new Promise((r) => setTimeout(r, 500)); await window.pigmentApp.presets.ready?.('brushes'); return { list: window.pigmentApp.presets.list('brushes').filter((p) => !p.builtin).map((p) => ({ id: p.id, name: p.name, data: p.data })), migrated: window.pigmentApp.settings.brushes?.migrated }; });
console.log('brush presets migrated', JSON.stringify(brushes));
console.log([...a.logs, ...b.logs, ...c.logs].join('\n') || 'no console errors');
await browser.close(); s05.kill(); s04.kill();
