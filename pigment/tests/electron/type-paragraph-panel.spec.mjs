// type-paragraph-panel (ARCHITECTURE.md "0.4 features", package 4) in the packaged runtime: the hyphenation patterns
// are separate modules imported on demand (lib/type/patterns/*.js), so they must load under pigment:// and the CSP;
// a German paragraph that hyphenates is laid out again when its patterns arrive, and the Paragraph panel is there.
import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(new URL('../..', import.meta.url).pathname);

test('hyphenation patterns load on demand under pigment:// and a German paragraph hyphenates', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'pigment-userdata-'));
  const app = await electron.launch({ args: ['.', '--no-sandbox', '--disable-gpu'], cwd: ROOT, env: { ...process.env, PIGMENT_USER_DATA: userData } });
  try {
    const window = await app.firstWindow();
    const problems = [];
    window.on('console', (m) => {
      if (m.type() === 'error' || (m.type() === 'warning' && /hyphenation|Content Security|import/i.test(m.text()))) problems.push(m.text());
    });
    await window.waitForSelector('body[data-ready]', { timeout: 60_000 });
    expect(window.url()).toMatch(/^pigment:/);
    await window.evaluate(async () => {
      const app = window.pigmentApp;
      await app.commands.run('file:new', { width: 400, height: 400 }, 'api');
      const { TextLayer } = await import('/lib/document.js');
      const M = await import('/lib/type/model.js');
      const text = 'Donaudampfschifffahrtsgesellschaftskapitän und Rechtsschutzversicherungsgesellschaften';
      let content = M.fromPlain(text, { size: 16, language: 'de' });
      content = M.applyPara(content, 0, text.length, { hyphenate: true, align: 'justify-left' });
      const layer = new TextLayer({ content, x: 10, y: 10, width: 140 });
      app.doc.add(layer);
      window.__layer = layer;
      layer.layout();
    });
    // the German patterns arrive in the background, then the layer is laid out again with hyphens
    await expect.poll(() => window.evaluate(() => window.__layer.layout().lines.some((l) => l.hyphen)), { timeout: 30_000 }).toBe(true);
    const r = await window.evaluate(async () => {
      const H = await import('/lib/type/hyphenation.js');
      return { de: H.languageReady('de'), panel: window.pigmentApp.panels.panels.has('paragraph'), stubbed: window.pigmentApp.stubbed.includes('window:panel-paragraph') };
    });
    expect(r).toEqual({ de: true, panel: true, stubbed: false });
    expect(problems).toEqual([]);
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});
