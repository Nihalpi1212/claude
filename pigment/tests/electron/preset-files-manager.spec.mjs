// preset-files-manager in the Electron build (rule 13): the Pigment libraries fetched over pigment://, a Photoshop
// .grd file opened from disk through the main process, a .pigment-bundle exported to disk and imported back, and
// Migrate Presets from a real presets folder (listDir / readFile over IPC).
import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(new URL('../..', import.meta.url).pathname);

test('presets: libraries over pigment://, a .grd from disk, a bundle to disk and back, Migrate Presets from a folder', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'pigment-userdata-'));
  const work = mkdtempSync(join(tmpdir(), 'pigment-presets-'));
  // an older Pigment's settings folder: presets/gradients.json
  mkdirSync(join(work, 'old', 'presets'), { recursive: true });
  writeFileSync(join(work, 'old', 'settings.json'), '{}');
  writeFileSync(join(work, 'old', 'presets', 'gradients.json'), JSON.stringify({ format: 'pigment-presets', version: 1, kind: 'gradients', kindVersion: 1, groups: [], items: [{ id: 'u-old', name: 'Migrated fade', group: null, data: { stops: [{ pos: 0, color: '#ff00ff' }, { pos: 1, color: '#00ffff' }] }, builtin: false }], hidden: [] }));
  const app = await electron.launch({ args: ['.', '--no-sandbox', '--disable-gpu'], cwd: ROOT, env: { ...process.env, PIGMENT_USER_DATA: userData, ELECTRON_ENABLE_LOGGING: '1' } });
  try {
    const window = await app.firstWindow();
    await window.waitForSelector('body[data-ready]', { timeout: 60_000 });
    const grdPath = join(work, 'Electron Gradients.grd');
    const bundlePath = join(work, 'All.pigment-bundle');
    const r = await window.evaluate(async ({ grdPath, bundlePath, oldDir }) => {
      const pigment = window.pigmentApp;
      const M = await import('./lib/preset-manager.js');
      const GRD = await import('./lib/preset-files/grd.js');
      const out = {};
      // a library through fetch over pigment:// (inside the asar in a packaged build)
      out.libs = (await M.pigmentLibraries('gradients')).map((l) => l.id);
      const lib = await M.loadPigmentLibrary(pigment, 'gradients-pigment');
      out.lib = lib.added;
      // a .grd written to disk through the bridge, opened like any file
      const { bytes } = GRD.writeGrdFile([{ name: 'From disk', data: { stops: [{ pos: 0, color: '#112233' }, { pos: 1, color: '#445566' }] } }]);
      await pigment.bridge.writeFile(grdPath, bytes);
      const docs = pigment.docs.list().length;
      await pigment.commands.run('file:open-paths', [grdPath], 'api');
      out.fromDisk = pigment.presets.list('gradients').some((p) => p.name === 'From disk');
      out.docs = pigment.docs.list().length - docs;
      // a bundle to disk, the library reset, the bundle back
      out.exported = await pigment.commands.run('edit:export-import-presets', { mode: 'export', path: bundlePath, kinds: ['gradients'], settings: false }, 'api');
      pigment.presets.reset('gradients');
      out.afterReset = pigment.presets.list('gradients').some((p) => p.name === 'From disk');
      const back = await pigment.commands.run('edit:export-import-presets', { mode: 'import', path: bundlePath, settings: false }, 'api');
      out.imported = back.added;
      out.back = pigment.presets.list('gradients').some((p) => p.name === 'From disk');
      const migrated = await pigment.commands.run('edit:migrate-presets', oldDir, 'api');
      out.migrated = migrated.added;
      out.fade = pigment.presets.list('gradients').some((p) => p.name === 'Migrated fade');
      await pigment.presets.flush();
      pigment.dialogs.closeAll();
      return out;
    }, { grdPath, bundlePath, oldDir: join(work, 'old') });
    expect(r.libs).toEqual(['gradients-pigment']);
    expect(r.lib).toEqual({ gradients: 8 });
    expect(r).toMatchObject({ fromDisk: true, docs: 0, exported: bundlePath, afterReset: false, back: true, fade: true });
    expect(r.imported.gradients).toBeGreaterThan(0);
    expect(r.migrated).toEqual({ gradients: 1 });
    expect(existsSync(bundlePath)).toBe(true);
    // the store wrote the imported presets through IPC
    const saved = JSON.parse(readFileSync(join(userData, 'presets', 'gradients.json'), 'utf8'));
    expect(saved.items.some((i) => i.name === 'Migrated fade')).toBe(true);
  } finally {
    await app.close().catch(() => {});
    rmSync(userData, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  }
});
