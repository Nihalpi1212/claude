import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { OUT_DIR } from '../fixtures/make-fixtures.mjs';

const ROOT = resolve(new URL('../..', import.meta.url).pathname);

async function launch(args = []) {
  const userData = mkdtempSync(join(tmpdir(), 'folio-userdata-'));
  const app = await electron.launch({
    args: ['.', '--no-sandbox', '--disable-gpu', ...args],
    cwd: ROOT,
    env: { ...process.env, FOLIO_USER_DATA: userData, ELECTRON_ENABLE_LOGGING: '1' },
  });
  const window = await app.firstWindow();
  await window.waitForSelector('body[data-ready="true"]', { timeout: 60_000 });
  return { app, window, userData, close: async () => {
    await app.close().catch(() => {});
    rmSync(userData, { recursive: true, force: true });
  } };
}

test('starts, exposes the preload bridge, opens a file from the command line and has a native menu', async () => {
  const fixture = join(OUT_DIR, 'text.pdf');
  const { app, window, close } = await launch([fixture]);
  try {
    expect(await window.evaluate(() => typeof window.folio)).toBe('object');
    expect(await window.evaluate(() => window.folio.platform)).toBe(process.platform);
    expect(await window.evaluate(() => typeof window.require)).toBe('undefined'); // sandboxed renderer
    expect(await window.evaluate(() => location.href)).toBe('folio://app/index.html');
    await window.waitForSelector('.doc-host:not([hidden]) .page[data-loaded="true"] canvas', { timeout: 60_000 });
    expect(await window.evaluate(() => window.folioApp.session?.path)).toBe(fixture);
    expect(await window.evaluate(() => window.folioApp.view.numPages)).toBe(5);
    expect(await window.title()).toContain('text.pdf');

    const menu = await app.evaluate(({ Menu }) => {
      const m = Menu.getApplicationMenu();
      return m ? m.items.map((i) => i.label) : null;
    });
    expect(menu).toContain('&File');
    expect(menu).toContain('&Tools');

    // a menu command reaches the renderer: zoom in through the View menu item
    const before = await window.evaluate(() => window.folioApp.view.scale);
    await app.evaluate(({ Menu }) => {
      const view = Menu.getApplicationMenu().items.find((i) => i.label === '&View');
      view.submenu.items.find((i) => i.label === 'Zoom &In').click();
    });
    await expect.poll(() => window.evaluate(() => window.folioApp.view.scale)).toBeGreaterThan(before);

    // settings round-trip through IPC lands in userData/settings.json
    await window.evaluate(() => window.folioApp.saveSettings({ theme: 'dark' }));
    const userData = await app.evaluate(({ app: a }) => a.getPath('userData'));
    await expect.poll(() => (existsSync(join(userData, 'settings.json')) ? JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf8')).theme : null)).toBe('dark');
    expect(await window.evaluate(() => document.documentElement.dataset.theme)).toBe('dark');

    // recent files were recorded
    const recent = await window.evaluate(() => window.folio.getRecent());
    expect(recent[0].path).toBe(fixture);
  } finally {
    await close();
  }
});

test('save writes the edited document through the main process and reload picks up disk changes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'folio-save-'));
  const file = join(dir, 'work.pdf');
  writeFileSync(file, readFileSync(join(OUT_DIR, 'form.pdf')));
  const { app, window, close } = await launch([file]);
  try {
    await window.waitForSelector('.doc-host:not([hidden]) .annotationLayer input[type="text"]', { timeout: 60_000 });
    const input = window.locator('.annotationLayer input[type="text"]').first();
    await input.fill('Saved via Electron');
    await input.blur();
    expect(await window.evaluate(() => window.folioApp.session.dirty)).toBe(true);
    await window.evaluate(() => window.folioApp.commands.run('file:save', undefined, 'api'));
    await expect.poll(() => window.evaluate(() => window.folioApp.session.dirty)).toBe(false);
    const saved = readFileSync(file);
    expect(saved.length).toBeGreaterThan(0);
    const fields = await window.evaluate(async (bytes) => {
      const engine = await import('/shared/engine.js');
      return engine.getFormData(new Uint8Array(bytes));
    }, [...saved]);
    expect(fields.find((f) => f.name === 'name').value).toBe('Saved via Electron');

    // an external change (different document) is picked up by the file watcher
    writeFileSync(file, readFileSync(join(OUT_DIR, 'text.pdf')));
    await expect.poll(() => window.evaluate(() => window.folioApp.view.numPages), { timeout: 20_000 }).toBe(5);

    // closing with no unsaved changes exits cleanly
    const exited = app.waitForEvent('close');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await exited;
  } finally {
    await close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// The packaged app (asar) must serve the renderer, vendor files and shared modules the same way.
const PACKAGED = { linux: join(ROOT, 'dist', 'linux-unpacked', 'folio-pdf'), darwin: join(ROOT, 'dist', 'mac-universal', 'Folio PDF.app', 'Contents', 'MacOS', 'Folio PDF'), win32: join(ROOT, 'dist', 'win-unpacked', 'Folio PDF.exe') }[process.platform];
test('packaged build opens a document', async () => {
  test.skip(!PACKAGED || !existsSync(PACKAGED), 'no packaged build in dist/ (run npm run pack)');
  const fixture = join(OUT_DIR, 'text.pdf');
  const userData = mkdtempSync(join(tmpdir(), 'folio-packaged-'));
  const app = await electron.launch({ executablePath: PACKAGED, args: ['--no-sandbox', '--disable-gpu', fixture], env: { ...process.env, FOLIO_USER_DATA: userData } });
  try {
    const window = await app.firstWindow();
    await window.waitForSelector('.doc-host:not([hidden]) .page[data-loaded="true"] canvas', { timeout: 60_000 });
    expect(await window.evaluate(() => window.folioApp.view.numPages)).toBe(5);
    expect(await window.evaluate(() => window.folio.isPackaged)).toBe(true);
    // shared modules and vendor files are served from inside the asar archive
    expect(await window.evaluate(async () => (await import('/shared/engine.js')).looksLikePdf(window.folioApp.session.bytes))).toBe(true);
    await window.evaluate(() => window.folioApp.commands.run('view:sidebar', 'thumbnails', 'api'));
    await window.waitForSelector('.thumb canvas', { timeout: 30_000 });
  } finally {
    await app.close().catch(() => {});
    rmSync(userData, { recursive: true, force: true });
  }
});
