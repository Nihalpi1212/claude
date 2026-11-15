// Shift+Alt+letter on Windows and Linux (ARCHITECTURE.md "0.4 features", O): the blend-mode keys share Alt with the
// menu mnemonics, so main.js takes them in before-input-event and runs their command as a key. The command is a
// disabled stub until finish-layer-menu lands (the test holds before and after); a command observer sees it arrive,
// once, with source 'key'.
// Also checks the menu command source (M.1): a menu item clicked runs with 'menu', its accelerator with 'menu-key'.
import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(new URL('../..', import.meta.url).pathname);

test('Shift+Alt+F reaches the renderer once as layer:blend-mode-soft-light with source key; menu clicks carry their source', async () => {
  test.skip(process.platform === 'darwin', 'macOS has no menu mnemonics: the page receives Shift+Option+letter itself');
  const userData = mkdtempSync(join(tmpdir(), 'pigment-userdata-'));
  const app = await electron.launch({ args: ['.', '--no-sandbox', '--disable-gpu'], cwd: ROOT, env: { ...process.env, PIGMENT_USER_DATA: userData, ELECTRON_ENABLE_LOGGING: '1' } });
  try {
    const window = await app.firstWindow();
    await window.waitForSelector('body[data-ready]', { timeout: 60_000 });
    await window.evaluate(() => {
      window.__seen = [];
      window.__keys = [];
      document.addEventListener('keydown', (e) => window.__keys.push(e.code), true);
      window.pigmentApp.commands.observe({ before: (id, arg, source) => ({ id, source }), after: (t, r, info) => window.__seen.push([t.id, t.source, info.refused]) });
    });
    await window.evaluate(() => window.focus());
    await app.evaluate(({ BrowserWindow }) => {
      const wc = BrowserWindow.getAllWindows()[0].webContents;
      wc.focus();
      for (const type of ['keyDown', 'keyUp']) wc.sendInputEvent({ type, keyCode: 'F', modifiers: ['shift', 'alt'] });
    });
    await expect.poll(() => window.evaluate(() => window.__seen.filter(([id]) => id === 'layer:blend-mode-soft-light'))).toEqual([['layer:blend-mode-soft-light', 'key', false]]);
    // main.js took the key: the page never saw it, so shortcuts.js did not dispatch it a second time
    expect(await window.evaluate(() => window.__keys.filter((c) => c === 'KeyF'))).toEqual([]);
    // registered; while it is a stub (in app.stubbed, until finish-layer-menu lands) it is disabled
    const state = await window.evaluate(() => {
      const app = window.pigmentApp;
      const id = 'layer:blend-mode-soft-light';
      return { has: app.commands.has(id), stubbed: app.stubbed.includes(id), enabled: app.commands.isEnabled(id) };
    });
    expect(state.has).toBe(true);
    if (state.stubbed) expect(state.enabled).toBe(false);
    // no menu opened by the mnemonic (&File): another key still reaches the page
    await window.waitForTimeout(300);
    expect(await window.evaluate(() => window.__seen.filter(([id]) => id !== 'layer:blend-mode-soft-light').map(([id]) => id))).toEqual([]);

    // menu items: a mouse click runs with 'menu', the accelerator with 'menu-key' (triggeredByAccelerator)
    await app.evaluate(({ Menu }) => {
      const find = (items, label) => {
        for (const it of items) {
          if (it.label === label) return it;
          const sub = it.submenu && find(it.submenu.items, label);
          if (sub) return sub;
        }
        return null;
      };
      const item = find(Menu.getApplicationMenu().items, 'Zoom &In') ?? find(Menu.getApplicationMenu().items, 'Zoom In');
      item.click(undefined, undefined, undefined);
      item.click({ triggeredByAccelerator: true }, undefined, undefined);
    });
    await expect.poll(() => window.evaluate(() => window.__seen.filter(([id]) => id === 'view:zoom-in').map(([, s]) => s))).toEqual(['menu', 'menu-key']);
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});
