// icc-engine (ARCHITECTURE.md "0.5 features", package 4) in the Electron runtime: LittleCMS's wasm loads from
// pigment://app/vendor/lcms2/ under the app's CSP ('wasm-unsafe-eval'), from the source tree and from inside an asar
// archive packed with electron-builder's file list (src/**, package.json, no source maps); a Display P3 PNG given on
// the command line opens tagged before the wasm is needed, and the operating system's profile folders are listed
// through the preload bridge.
import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative } from 'node:path';

const ROOT = resolve(new URL('../..', import.meta.url).pathname);

/** A 16 x 12 PNG of one colour with Pigment's Display P3 profile in its iCCP chunk. */
async function taggedPng(dir) {
  const { encodePng } = await import(join(ROOT, 'src', 'shared', 'pixels', 'png.js'));
  const { writeChunks } = await import(join(ROOT, 'src', 'renderer', 'lib', 'io-chunks.js'));
  const { builtinIcc } = await import(join(ROOT, 'src', 'renderer', 'lib', 'color', 'profiles.js'));
  const rgba = new Uint8Array(16 * 12 * 4).map((_, i) => [200, 100, 50, 255][i % 4]);
  const png = await writeChunks(await encodePng({ width: 16, height: 12, channels: 4, depth: 8, data: rgba }), 'png', { icc: builtinIcc('display-p3') });
  const path = join(dir, 'p3.png');
  writeFileSync(path, png);
  return path;
}

async function check(app, { ignore = [] } = {}) {
  const window = await app.firstWindow();
  const problems = [];
  window.on('console', (m) => {
    const text = `${m.text()} @ ${m.location()?.url ?? ''}`;
    if (ignore.some((re) => re.test(text))) return;
    if (m.type() === 'error' || (m.type() === 'warning' && /lcms|wasm|Content Security|colour|color/i.test(m.text()))) problems.push(text);
  });
  await window.waitForSelector('body[data-ready]', { timeout: 60_000 });
  expect(window.url()).toMatch(/^pigment:/);
  await expect.poll(() => window.evaluate(() => window.pigmentApp.doc?.profile?.name ?? null), { timeout: 30_000 }).toBe('Display P3');
  const r = await window.evaluate(async () => {
    const P = await import('/lib/color/pipeline.js');
    const L = await import('/lib/color/lcms.js');
    await P.colorEngine().ready();
    const T = await import('/lib/color/transforms.js');
    // LittleCMS itself converts (16-bit pixels go through the wasm)
    const t = T.makeTransform(P.colorEngine().profileById('display-p3'), null, { format: 'rgba16' });
    const px = Uint16Array.of(65535, 0, 0, 65535);
    t.apply(px, px, 1);
    const profiles = await window.pigment.listColorProfiles();
    return { id: P.colorEngine().id, lcms: !!L.lcms(), kind: t.kind, red: Array.from(px), listed: Array.isArray(profiles), described: P.describe(window.pigmentApp.doc), status: document.querySelector('#statusbar [data-key="profile"]')?.textContent ?? null };
  });
  expect(r).toMatchObject({ id: 'lcms2', lcms: true, kind: 'lcms', listed: true, described: 'Display P3', status: 'Display P3' });
  expect(r.red[0]).toBe(65535);
  expect(problems).toEqual([]);
}

test('LittleCMS loads under pigment:// and a Display P3 PNG from the command line opens tagged', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'pigment-userdata-'));
  const dir = mkdtempSync(join(tmpdir(), 'pigment-icc-'));
  const file = await taggedPng(dir);
  const app = await electron.launch({ args: ['.', '--no-sandbox', '--disable-gpu', file], cwd: ROOT, env: { ...process.env, PIGMENT_USER_DATA: userData } });
  try {
    await check(app);
  } finally {
    await app.close().catch(() => {});
    rmSync(userData, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the same from inside an asar archive packed with electron-builder\'s file list', async () => {
  test.skip(!existsSync(join(ROOT, 'src', 'renderer', 'vendor', 'lcms2', 'lcms.wasm')), 'the vendor step has not run');
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
  expect(asar.listPackage(target, { isPack: false }).some((f) => /vendor[\\/]lcms2[\\/]lcms\.wasm$/.test(f))).toBe(true);
  expect(files.map((f) => relative(ROOT, f)).some((f) => f.includes('lcms2'))).toBe(true);
  const file = await taggedPng(work);
  const app = await electron.launch({ args: [target, '--no-sandbox', '--disable-gpu', file], cwd: work, env: { ...process.env, PIGMENT_USER_DATA: userData } });
  try {
    // not this package's: electron-builder's file list leaves out build/, so the welcome screen's /build/icon.png is a
    // 404 inside the asar and its onerror attribute is refused by the CSP (reported to the integrator)
    await check(app, { ignore: [/build\/icon\.png/, /Executing inline event handler violates/] });
  } finally {
    await app.close().catch(() => {});
    rmSync(userData, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  }
});
