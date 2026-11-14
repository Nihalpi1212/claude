// type-engine-core (ARCHITECTURE.md "0.4 features", package 1) in the packaged runtime: the HarfBuzz wasm loads from
// pigment://app/vendor/harfbuzz/ under the app's CSP ('wasm-unsafe-eval'), installed fonts arrive through
// queryLocalFonts() (Electron grants 'local-fonts'), and a text layer in an installed family is drawn by the engine.
import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(new URL('../..', import.meta.url).pathname);

test('HarfBuzz loads under pigment:// and draws a text layer in an installed family', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'pigment-userdata-'));
  const app = await electron.launch({ args: ['.', '--no-sandbox', '--disable-gpu'], cwd: ROOT, env: { ...process.env, PIGMENT_USER_DATA: userData } });
  try {
    const window = await app.firstWindow();
    const problems = [];
    window.on('console', (m) => {
      if (m.type() === 'error' || (m.type() === 'warning' && /HarfBuzz|wasm|Content Security/i.test(m.text()))) problems.push(m.text());
    });
    await window.waitForSelector('body[data-ready]', { timeout: 60_000 });
    expect(window.url()).toMatch(/^pigment:/);
    await expect.poll(() => window.evaluate(async () => (await import('/lib/type/api.js')).fonts.available), { timeout: 30_000 }).toBe(true);
    // a family this machine has (a common one, else the first listed), so the test does not depend on Arial
    const family = await window.evaluate(async () => {
      const list = await window.queryLocalFonts();
      const prefer = ['DejaVu Sans', 'Liberation Sans', 'Arial', 'Helvetica', 'Segoe UI', 'Noto Sans'];
      return prefer.find((f) => list.some((d) => d.family === f)) ?? list[0]?.family ?? null;
    });
    test.skip(!family, 'no installed fonts to read');
    await window.evaluate(async (f) => {
      const app = window.pigmentApp;
      await app.commands.run('file:new', { width: 300, height: 120 }, 'api');
      const { TextLayer } = await import('/lib/document.js');
      const M = await import('/lib/type/model.js');
      const layer = new TextLayer({ content: M.fromPlain('Shaped', { fontFamily: f, size: 40, color: '#000000' }), x: 10, y: 20 });
      app.doc.add(layer);
      window.__layer = layer;
      layer.layout();
    }, family);
    // the family's faces load in the background, then the layer is laid out again by the engine
    await expect.poll(() => window.evaluate(() => window.__layer.layout().engine), { timeout: 30_000 }).toBe('harfbuzz');
    const r = await window.evaluate(() => {
      const layer = window.__layer;
      const run = layer.layout().lines[0].runs[0];
      const out = layer.renderBase();
      const d = out.canvas.getContext('2d').getImageData(0, 0, out.canvas.width, out.canvas.height).data;
      let ink = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 128) ink++;
      // each face is also a CSS FontFace (colour glyphs and fallback text draw with it): the CSP lets it in
      const faces = [...document.fonts].filter((f) => f.family.replace(/"/g, '').startsWith('pigment-face-') && f.status === 'loaded').length;
      return { glyphs: run.units.filter((u) => u.kind === 'glyphs').length, ink, faces };
    });
    expect(r.glyphs).toBe(6);
    expect(r.faces).toBeGreaterThan(0);
    expect(r.ink).toBeGreaterThan(200);
    expect(problems).toEqual([]);
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});
