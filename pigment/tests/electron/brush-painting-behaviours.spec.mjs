// brush-painting-behaviours in Electron (ARCHITECTURE.md "0.5 features", package 3, rule 13): main.js takes
// Shift+Alt+letter before the page on Windows and Linux and sends the global command (Layer > Blend Mode); app.js
// passes it through app.keymap.resolveKey, so with a painting tool active it sets the tool's mode (S13.4), and with the
// Move tool the layer's as in 0.4. The paint-only keys (Shift+Alt+Q Behind) come from main as their paint command. The
// digits and the resize HUD (Alt+right-drag from native input events) reach the Brush in the packaged renderer too.
import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(new URL('../..', import.meta.url).pathname);

test('Shift+Alt+letter sets the Brush\'s mode through resolveKey (the layer\'s with the Move tool); digits and the resize HUD', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'pigment-userdata-'));
  const app = await electron.launch({ args: ['.', '--no-sandbox', '--disable-gpu'], cwd: ROOT, env: { ...process.env, PIGMENT_USER_DATA: userData, ELECTRON_ENABLE_LOGGING: '1' } });
  try {
    const window = await app.firstWindow();
    await window.waitForSelector('body[data-ready]', { timeout: 60_000 });
    await window.evaluate(() => window.pigmentApp.newDocument({ width: 300, height: 200, name: 'Keys', background: 'transparent' }));
    await window.waitForSelector('.doc-frame:not([hidden]) canvas.view');
    const state = () => window.evaluate(() => {
      const a = window.pigmentApp;
      return { toolBlend: a.tools.opt('brush', 'blend'), layerBlend: a.doc.active.blend, opacity: a.tools.opt('brush', 'opacity'), size: a.tools.opt('brush', 'size'), layerOpacity: a.doc.active.opacity };
    });
    await window.evaluate(async () => {
      const a = window.pigmentApp;
      const { PaintGesture } = await import('./lib/tools/paint-gesture.js');
      if (!PaintGesture.real) throw new Error('the stub gesture is loaded');
      a.tools.activate('brush');
      a.tools.setOpt('brush', 'size', 20);
      a.view.setZoom(1);
      document.activeElement?.blur?.();
    });
    const send = (events) =>
      app.evaluate(({ BrowserWindow }, list) => {
        const wc = BrowserWindow.getAllWindows()[0].webContents;
        wc.focus();
        for (const e of list) wc.sendInputEvent(e);
      }, events);
    const key = (keyCode, modifiers = []) => send([{ type: 'keyDown', keyCode, modifiers }, { type: 'char', keyCode, modifiers }, { type: 'keyUp', keyCode, modifiers }]);

    // Shift+Alt+M with the Brush: the Brush's mode, the layer stays Normal
    await key('M', ['shift', 'alt']);
    await expect.poll(state, { timeout: 10_000 }).toMatchObject({ toolBlend: 'multiply', layerBlend: 'normal' });
    // Shift+Alt+Q (Behind) has no global binding: main sends the paint command itself
    await key('Q', ['shift', 'alt']);
    await expect.poll(state, { timeout: 10_000 }).toMatchObject({ toolBlend: 'behind', layerBlend: 'normal' });
    // digits: the Brush's opacity
    await key('7');
    await expect.poll(state, { timeout: 10_000 }).toMatchObject({ opacity: 0.7, layerOpacity: 1 });

    // Alt+right-drag (native mouse events): the resize HUD sets the size, nothing is painted
    const at = await window.evaluate(() => {
      const r = document.querySelector('.doc-frame:not([hidden]) canvas.view').getBoundingClientRect();
      const s = window.pigmentApp.view.toScreen(150, 100);
      return { x: Math.round(r.left + s.x), y: Math.round(r.top + s.y) };
    });
    await send([
      { type: 'mouseMove', x: at.x, y: at.y },
      { type: 'mouseDown', x: at.x, y: at.y, button: 'right', clickCount: 1, modifiers: ['alt'] },
      { type: 'mouseMove', x: at.x + 10, y: at.y, button: 'right', modifiers: ['alt', 'rightButtonDown'] },
      { type: 'mouseMove', x: at.x + 20, y: at.y, button: 'right', modifiers: ['alt', 'rightButtonDown'] },
      { type: 'mouseUp', x: at.x + 20, y: at.y, button: 'right', clickCount: 1, modifiers: ['alt'] },
    ]);
    await expect.poll(async () => (await state()).size, { timeout: 10_000 }).toBe(60);
    expect(await window.evaluate(() => window.pigmentApp.doc.history.index + 1)).toBe(0);

    // the Move tool: Shift+Alt+M is the layer's again (0.4)
    await window.evaluate(() => window.pigmentApp.tools.activate('move'));
    await key('M', ['shift', 'alt']);
    await expect.poll(state, { timeout: 10_000 }).toMatchObject({ toolBlend: 'behind', layerBlend: 'multiply' });
  } finally {
    await app.windows()[0]?.evaluate(() => window.pigmentApp.docs.list().forEach((d) => d.history.markSaved())).catch(() => {});
    await app.close().catch(() => {});
    rmSync(userData, { recursive: true, force: true });
  }
});
