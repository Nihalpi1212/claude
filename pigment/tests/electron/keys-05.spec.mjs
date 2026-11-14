// Keys and the native menu in 0.5 (ARCHITECTURE.md "0.5 features", S9.3–S9.5, S13.3): F7 runs Window > Layers once;
// an overlay in app.keymap changes the native accelerator; a hidden item is absent and a coloured one has an icon;
// with an action on F7 the Layers item has no accelerator and F7 plays only the action.
//
// Where a key arrives from: on Windows and Linux the page sees an accelerator key before the native menu, and
// shortcuts.js prevents its default, so the menu's copy never fires (source 'key'); on macOS the menu takes it first
// (source 'menu-key'). Either way the command runs once.
import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(new URL('../..', import.meta.url).pathname);

/** The native menu item(s) with this label, anywhere: [{ label, accelerator, hasIcon, path }]. */
const items = (app, label) =>
  app.evaluate(({ Menu }, l) => {
    const out = [];
    const walk = (list, path) => {
      for (const it of list) {
        if (it.label === l) out.push({ label: it.label, accelerator: it.accelerator ?? null, hasIcon: !!it.icon && !it.icon.isEmpty(), path: [...path, it.label] });
        if (it.submenu) walk(it.submenu.items, [...path, it.label]);
      }
    };
    walk(Menu.getApplicationMenu().items, []);
    return out;
  }, label);
const pressF7 = (app) =>
  app.evaluate(({ BrowserWindow }) => {
    const wc = BrowserWindow.getAllWindows()[0].webContents;
    wc.focus();
    for (const type of ['keyDown', 'keyUp']) wc.sendInputEvent({ type, keyCode: 'F7' });
  });

test('F7, an overlay, hidden and coloured items, and an action that owns F7', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'pigment-userdata-'));
  const app = await electron.launch({ args: ['.', '--no-sandbox', '--disable-gpu'], cwd: ROOT, env: { ...process.env, PIGMENT_USER_DATA: userData, ELECTRON_ENABLE_LOGGING: '1' } });
  try {
    const window = await app.firstWindow();
    await window.waitForSelector('body[data-ready]', { timeout: 60_000 });
    await window.evaluate(() => {
      window.__seen = [];
      window.pigmentApp.commands.observe({ before: (id, arg, source) => window.__seen.push([id, source]) });
    });
    const source = process.platform === 'darwin' ? 'menu-key' : 'key';

    // F7: Window > Layers, once
    const layersItem = async () => (await items(app, 'Layers')).find((x) => x.path[0] === '&Window');
    expect((await layersItem()).accelerator).toBe('F7');
    await pressF7(app);
    await expect.poll(() => window.evaluate(() => window.__seen.filter(([id]) => id === 'window:panel-layers'))).toEqual([['window:panel-layers', source]]);
    await window.waitForTimeout(300);
    expect(await window.evaluate(() => window.__seen.filter(([id]) => id === 'window:panel-layers').length)).toBe(1);

    // an overlay changes the native accelerator (the ui state carries the resolved overlay to main.js)
    await window.evaluate(() => window.pigmentApp.keymap.set('layer:new', ['CmdOrCtrl+Alt+K']));
    await expect.poll(async () => (await items(app, 'Layer…')).find((x) => x.path[1] === '&New')?.accelerator).toBe('CmdOrCtrl+Alt+K');

    // a hidden item is absent, a coloured one has an icon, and File ends with Show All Menu Items
    await window.evaluate(() => window.pigmentApp.keymap.setMenus({ hidden: ['file:print'], colors: { 'file:save': 'green' } }));
    await expect.poll(async () => (await items(app, '&Print…')).length).toBe(0);
    expect((await items(app, '&Save'))[0].hasIcon).toBe(true);
    expect((await items(app, 'Show All Menu Items')).map((x) => x.path[0])).toEqual(['&File']);

    // an action on F7 owns the key: the Layers item loses its accelerator and F7 plays only the action
    await window.evaluate(() => {
      window.pigmentApp.actions.newAction({ name: 'F7 action', functionKey: { key: 'F7' } });
      window.__seen = [];
    });
    await expect.poll(async () => (await layersItem()).accelerator).toBe(null);
    expect(await window.evaluate(() => window.pigmentApp.keymap.keysFor('window:panel-layers'))).toEqual([]);
    await pressF7(app);
    await expect.poll(() => window.evaluate(() => window.__seen.filter(([id]) => id === 'actions:play').length)).toBe(1);
    await window.waitForTimeout(300);
    expect(await window.evaluate(() => window.__seen.filter(([id]) => id === 'window:panel-layers'))).toEqual([]);
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});
