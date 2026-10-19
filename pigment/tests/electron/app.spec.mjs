// Launches the real Electron app: main process, preload bridge, protocol, IPC, native menu, saving.
import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { OUT_DIR } from '../fixtures/make-fixtures.mjs';

const ROOT = resolve(new URL('../..', import.meta.url).pathname);

async function launch(args = []) {
  const userData = mkdtempSync(join(tmpdir(), 'pigment-userdata-'));
  const app = await electron.launch({
    args: ['.', '--no-sandbox', '--disable-gpu', ...args],
    cwd: ROOT,
    env: { ...process.env, PIGMENT_USER_DATA: userData, ELECTRON_ENABLE_LOGGING: '1' },
  });
  const window = await app.firstWindow();
  await window.waitForSelector('body[data-ready]', { timeout: 60_000 });
  return {
    app,
    window,
    userData,
    close: async () => {
      await app.close().catch(() => {});
      rmSync(userData, { recursive: true, force: true });
    },
  };
}

test('starts, opens an image from the command line, has the native menu and saves through IPC', async () => {
  const fixture = join(OUT_DIR, 'layers.psd');
  const { app, window, close } = await launch([fixture]);
  try {
    expect(await window.evaluate(() => typeof window.pigment)).toBe('object');
    expect(await window.evaluate(() => window.pigment.platform)).toBe(process.platform);
    expect(await window.evaluate(() => typeof window.require)).toBe('undefined'); // sandboxed renderer
    expect(await window.evaluate(() => location.href)).toBe('pigment://app/index.html');
    await expect.poll(() => window.evaluate(() => window.pigmentApp.doc?.path ?? null), { timeout: 60_000 }).toBe(fixture);
    expect(await window.evaluate(() => window.pigmentApp.doc.layers().length)).toBe(3);
    await expect.poll(() => window.title()).toContain('layers');

    const menu = await app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.items.map((i) => i.label) ?? []);
    for (const label of ['&File', '&Edit', '&Image', '&Layer', '&Select', 'Fil&ter', '&View', '&Window']) expect(menu).toContain(label);

    // a menu click reaches the renderer: Image › Image Rotation › 90° Clockwise
    await app.evaluate(({ Menu }) => {
      const image = Menu.getApplicationMenu().items.find((i) => i.label === '&Image');
      image.submenu.items.find((i) => i.label === 'Image Rotatio&n').submenu.items.find((i) => i.label === '90° Clockwise').click();
    });
    await expect.poll(() => window.evaluate(() => [window.pigmentApp.doc.width, window.pigmentApp.doc.height])).toEqual([90, 120]);

    // Save As .pigment writes the file through the main process
    const dir = mkdtempSync(join(tmpdir(), 'pigment-save-'));
    const target = join(dir, 'rotated.pigment');
    await window.evaluate((path) => window.pigmentApp.docs.writeTo(window.pigmentApp.doc, path), target);
    await expect.poll(() => existsSync(target)).toBe(true);
    expect(readFileSync(target).subarray(0, 2).toString('latin1')).toBe('PK'); // zip container
    rmSync(dir, { recursive: true, force: true });

    // settings round-trip lands in userData/settings.json
    await window.evaluate(() => window.pigmentApp.saveSettings({ theme: 'dark' }));
    const userData = await app.evaluate(({ app: a }) => a.getPath('userData'));
    await expect.poll(() => (existsSync(join(userData, 'settings.json')) ? JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf8')).theme : null)).toBe('dark');

    // clipboard: copy merged then paste as a new document goes through the native clipboard
    await window.evaluate(() => window.pigmentApp.commands.run('edit:copy-merged', undefined, 'api'));
    const hasImage = await app.evaluate(({ clipboard }) => !clipboard.readImage().isEmpty());
    expect(hasImage).toBe(true);
  } finally {
    await close();
  }
});
