// type-fonts (ARCHITECTURE.md "0.5 features", package 12) in the packaged runtime: the bundled fonts load from
// pigment://app/fonts/ (from the source tree and from inside an asar archive packed with electron-builder's file list)
// under the app's CSP, the catalog lists the installed fonts with their real styles from queryLocalFonts (Electron
// grants 'local-fonts'), classifies them from slices of their files, and a text layer in the bundled variable family
// is drawn by HarfBuzz with the style's instance.
import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtempSync, rmSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(new URL('../..', import.meta.url).pathname);

async function check(app, { ignore = [] } = {}) {
  const window = await app.firstWindow();
  const problems = [];
  window.on('console', (m) => {
    const text = `${m.text()} @ ${m.location()?.url ?? ''}`;
    if (ignore.some((re) => re.test(text))) return;
    if (m.type() === 'error' || (m.type() === 'warning' && /font|Content Security/i.test(m.text()))) problems.push(text);
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
  if (r.pick) {
    expect(r.source).toBe('system');
    expect(r.synthetic).toBe(false);
    expect(r.styles).toBe(true);
    // classification is read in the background from the files' tables
    await expect.poll(() => window.evaluate(async (f) => (await import('/lib/type/api.js')).fontCatalog().family(f)?.classification ?? null, r.pick), { timeout: 30_000 }).not.toBeNull();
  }
  // the bundled variable family draws with HarfBuzz at the style's weight (its file fetched over pigment://)
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
  return r;
}

test('bundled fonts load under pigment://, installed fonts list their real styles and classes', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'pigment-userdata-'));
  const app = await electron.launch({ args: ['.', '--no-sandbox', '--disable-gpu'], cwd: ROOT, env: { ...process.env, PIGMENT_USER_DATA: userData } });
  try {
    const r = await check(app);
    test.skip(!r.pick, 'no installed fonts to read');
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});

test('the same from inside an asar archive packed with electron-builder\'s file list', async () => {
  const asar = await import('@electron/asar');
  const work = mkdtempSync(join(tmpdir(), 'pigment-asar-'));
  const userData = mkdtempSync(join(tmpdir(), 'pigment-userdata-'));
  // package.json "build.files": src/**/*, package.json, !**/*.map
  const files = [join(ROOT, 'package.json')];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (!p.endsWith('.map')) files.push(p);
    }
  };
  walk(join(ROOT, 'src'));
  const target = join(work, 'app.asar');
  await asar.createPackageFromFiles(ROOT, target, files, {}, {});
  const listed = asar.listPackage(target, { isPack: false });
  expect(listed.some((f) => /renderer[\\/]fonts[\\/]SourceSans3VF-Upright\.ttf$/.test(f))).toBe(true);
  expect(listed.some((f) => /renderer[\\/]fonts[\\/]SourceSans3-LICENSE\.md$/.test(f))).toBe(true);
  const app = await electron.launch({ args: [target, '--no-sandbox', '--disable-gpu'], cwd: work, env: { ...process.env, PIGMENT_USER_DATA: userData } });
  try {
    // not this package's: electron-builder's file list leaves out build/, so the welcome screen's /build/icon.png is a
    // 404 inside the asar and its onerror attribute is refused by the CSP (icc-engine reported it to the integrator)
    await check(app, { ignore: [/build\/icon\.png/, /Executing inline event handler violates/] });
  } finally {
    await app.close().catch(() => {});
    rmSync(userData, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  }
});
