// type-fonts (ARCHITECTURE.md "0.5 features", package 12) in the packaged runtime: the bundled fonts load from
// pigment://app/fonts/ (inside the asar in a packaged build) under the app's CSP, the catalog lists the installed
// fonts with their real styles from queryLocalFonts (Electron grants 'local-fonts'), classifies them from slices of
// their files, and a text layer in the bundled variable family is drawn by HarfBuzz with the style's instance.
import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(new URL('../..', import.meta.url).pathname);

test('bundled fonts load under pigment://, installed fonts list their real styles and classes', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'pigment-userdata-'));
  const app = await electron.launch({ args: ['.', '--no-sandbox', '--disable-gpu'], cwd: ROOT, env: { ...process.env, PIGMENT_USER_DATA: userData } });
  try {
    const window = await app.firstWindow();
    const problems = [];
    window.on('console', (m) => {
      if (m.type() === 'error' || (m.type() === 'warning' && /font|Content Security/i.test(m.text()))) problems.push(m.text());
    });
    await window.waitForSelector('body[data-ready]', { timeout: 60_000 });
    expect(window.url()).toMatch(/^pigment:/);
    const r = await window.evaluate(async () => {
      const { fontCatalog } = await import('/lib/type/api.js');
      const c = fontCatalog();
      await c.ready();
      const installed = await window.queryLocalFonts();
      const pick = ['Liberation Sans', 'DejaVu Sans', 'Arial', 'Segoe UI', 'Helvetica Neue'].find((f) => installed.some((d) => d.family === f)) ?? installed[0]?.family ?? null;
      const fam = pick ? c.family(pick) : null;
      return {
        real: c.real,
        bundled: c.family('SourceSans3VF')?.source,
        pick,
        source: fam?.source ?? null,
        synthetic: !!fam?.synthetic,
        // every style of an installed family is a face of the system (its PostScript name)
        styles: fam ? fam.styles.every((s) => installed.some((d) => d.postscriptName === s.postScriptName)) : null,
      };
    });
    expect(r.real).toBe(true);
    expect(r.bundled).toBe('bundled');
    test.skip(!r.pick, 'no installed fonts to read');
    expect(r.source).toBe('system');
    expect(r.synthetic).toBe(false);
    expect(r.styles).toBe(true);
    // classification is read in the background from the files' tables
    await expect.poll(() => window.evaluate(async (f) => (await import('/lib/type/api.js')).fontCatalog().family(f)?.classification ?? null, r.pick), { timeout: 30_000 }).not.toBeNull();
    // the bundled variable family draws with HarfBuzz at the style's weight
    await window.evaluate(async () => {
      const app = window.pigmentApp;
      await app.commands.run('file:new', { width: 400, height: 120 }, 'api');
      const { TextLayer } = await import('/lib/document.js');
      const M = await import('/lib/type/model.js');
      const layer = new TextLayer({ content: M.fromPlain('Bundled', { fontFamily: 'SourceSans3VF', fontWeight: 700, size: 40, color: '#000000' }), x: 10, y: 20 });
      app.doc.add(layer);
      window.__layer = layer;
      layer.layout();
    });
    await expect.poll(() => window.evaluate(() => window.__layer.layout().engine), { timeout: 30_000 }).toBe('harfbuzz');
    const run = await window.evaluate(() => {
      const r0 = window.__layer.layout().lines[0].runs[0];
      return { ps: r0.face.postScriptName, weight: r0.face.weight };
    });
    expect(run).toEqual({ ps: 'SourceSans3VF-Bold', weight: 700 });
    expect(problems).toEqual([]);
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});
