// Write each golden PSD in the 0.5 app, read the same bytes with 0.4's and 0.5's readPsdDocument, compare summaries.
import { chromium } from '/home/user/claude/pigment/node_modules/playwright-core/index.mjs';
import { spawn } from 'node:child_process';
import { PSD_GOLDEN_DOCS, pagePsdGolden } from '/home/user/claude/pigment/tests/e2e/goldens.mjs';
const here = new URL('.', import.meta.url).pathname;
const s5 = spawn('node', ['/home/user/claude/pigment/tests/e2e/server.mjs', '8870'], { stdio: 'ignore' });
const s4 = spawn('node', [`${here}v04/pigment/tests/e2e/server.mjs`, '8871'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 800));
const browser = await chromium.launch();
const open = async (port) => { const p = await browser.newPage({ viewport: { width: 1200, height: 800 } }); p.on('pageerror', (e) => console.log('pageerror', port, e.message)); await p.goto(`http://127.0.0.1:${port}/index.html`); await p.waitForSelector('body[data-ready]'); return p; };
const p5 = await open(8870), p4 = await open(8871);
await p5.evaluate(() => { window.__goldenWritePsd = async (d) => { const { writePsdDocument } = await import('/lib/io.js'); const b = writePsdDocument(d, d.view.compositor); window.__bytes = b; return b; }; });
const summarize = async (page, b64) => page.evaluate(async (b64) => {
  const { readPsdDocument } = await import('/lib/io.js');
  const bin = atob(b64); const bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const doc = readPsdDocument(bytes);
  const hash = (c) => { if (!c) return null; const d = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height).data; let h = 0; for (let i = 0; i < d.length; i++) h = (h * 31 + d[i]) >>> 0; return `${c.width}x${c.height}:${h}`; };
  const walk = (g) => g.children.map((l) => ({ type: l.type, name: l.name, visible: l.visible, opacity: l.opacity, fill: l.fillOpacity, blend: l.blend, clip: l.clip, locked: l.locked, x: l.x, y: l.y, px: l.type === 'raster' ? hash(l.canvas) : null, mask: l.mask ? { en: l.mask.enabled, h: hash(l.mask.canvas) } : null, blending: l.blending ?? null, kind: l.kind ?? null, params: l.params ?? null, text: l.type === 'text' ? JSON.stringify(l.content ?? l.text ?? null) : null, font: l.font ?? null, children: l.isGroup ? walk(l) : null }));
  return JSON.stringify({ w: doc.width, h: doc.height, dpi: doc.dpi, guides: doc.guides ?? null, layers: walk(doc.root), active: doc.active?.name ?? null });
}, b64);
for (const id of PSD_GOLDEN_DOCS) {
  await p5.evaluate(pagePsdGolden, id);
  const b64 = await p5.evaluate(() => { const b = window.__bytes; let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); });
  const a = await summarize(p4, b64), b = await summarize(p5, b64);
  if (a === b) console.log(id, 'read EQUAL'); else { console.log(id, 'read DIFF'); const A = JSON.parse(a), B = JSON.parse(b); console.log(' 0.4', JSON.stringify(A).slice(0, 1500)); console.log(' 0.5', JSON.stringify(B).slice(0, 1500)); }
}
await browser.close(); s5.kill(); s4.kill();
