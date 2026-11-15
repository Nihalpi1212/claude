// Independent trace of a few golden cases on the untouched 0.4.0 copy (v04/), compared with the recorded fixtures.
import { chromium } from '/home/user/claude/pigment/node_modules/playwright-core/index.mjs';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { CASES, W, H } from '/home/user/claude/pigment/tests/e2e/goldens.mjs';
import { decodePng, toRgba8 } from '/home/user/claude/pigment/src/shared/pixels/png.js';
const port = 8871;
const here = new URL('.', import.meta.url).pathname;
const srv = spawn('node', [`${here}v04/pigment/tests/e2e/server.mjs`, String(port)], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 700));
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
const logs = [];
page.on('pageerror', (e) => logs.push(e.message));
await page.goto(`http://127.0.0.1:${port}/index.html`);
await page.waitForSelector('body[data-ready]', { timeout: 15000 });
const pick = ['hard-line', 'soft-s-curve', 'pressure-size', 'pressure-opacity', 'pencil', 'multiply', 'selection-clip', 'angle-roundness', 'mask-black'];
const res = await page.evaluate(async ({ cases, W, H }) => {
  const app = window.pigmentApp;
  const { BrushStroke } = await import('/lib/brush.js');
  const { Selection } = await import('/lib/selection.js');
  const { createCanvas } = await import('/lib/document.js');
  app.newDocument({ width: W, height: H, name: 'T', background: 'transparent' });
  const out = [];
  for (const c of cases) {
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext('2d');
    if (c.base === 'mask') { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, W, H); }
    if (c.base === 'pattern') {
      const img = ctx.createImageData(W, H);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        const a = y < 80 ? 255 : y >= 90 && y < 100 ? 128 : 0;
        img.data[i] = Math.round(x * 255 / (W - 1)); img.data[i + 1] = 128 + Math.round(60 * Math.sin(y / 9)); img.data[i + 2] = 255 - img.data[i]; img.data[i + 3] = a;
      }
      ctx.putImageData(img, 0, 0);
    }
    const dabs = [];
    const orig = BrushStroke.prototype.dab;
    BrushStroke.prototype.dab = function (x, y, p = 1) { dabs.push({ x, y, pressure: p, size: this.effectiveSize(p) }); return orig.call(this, x, y, p); };
    const history = { beginStroke(cv) { const b = createCanvas(cv.width, cv.height); b.getContext('2d').drawImage(cv, 0, 0); return { backup: b }; }, endStroke: () => null, cancelStroke() {} };
    const selection = c.selection ? Selection.fromEllipse(W, H, c.selection.rect) : null;
    const st = new BrushStroke({ target: { canvas, x: 0, y: 0, mask: c.target === 'mask' }, layer: null, settings: c.settings, selection, history });
    st.begin(c.samples[0]);
    for (const s of c.samples.slice(1)) st.extend(s);
    const sm = st.s.smoothing; st.s.smoothing = 0; st.extend(c.samples[c.samples.length - 1]); st.s.smoothing = sm;
    st.end();
    BrushStroke.prototype.dab = orig;
    const d = ctx.getImageData(0, 0, W, H).data;
    let s = ''; for (let i = 0; i < d.length; i += 0x8000) s += String.fromCharCode(...d.subarray(i, i + 0x8000));
    out.push({ id: c.id, dabs, rgba: btoa(s) });
  }
  return out;
}, { cases: CASES.filter((c) => pick.includes(c.id)), W, H });
const golden = JSON.parse(readFileSync('/home/user/claude/pigment/tests/fixtures/brush-golden/dabs.json', 'utf8'));
for (const r of res) {
  const g = golden[r.id];
  const dabsEqual = g.length === r.dabs.length && g.every((d, i) => d.x === r.dabs[i].x && d.y === r.dabs[i].y && d.size === r.dabs[i].size && d.pressure === r.dabs[i].pressure);
  const png = toRgba8(await decodePng(readFileSync(`/home/user/claude/pigment/tests/fixtures/brush-golden/${r.id}.png`)));
  const mine = Buffer.from(r.rgba, 'base64');
  const data = png.data ?? png;
  let max = 0, n = 0; for (let i = 0; i < mine.length; i++) { const dd = Math.abs(mine[i] - data[i]); if (dd) n++; max = Math.max(max, dd); }
  console.log(r.id, 'dabs', r.dabs.length, '/', g.length, dabsEqual ? 'EQUAL' : 'DIFF', 'pixels maxdiff', max, 'ndiff', n, 'len', mine.length, data.length);
}
console.log(logs.join('\n') || 'no page errors');
await browser.close(); srv.kill();
