// brush-engine-core in Electron (ARCHITECTURE.md "0.5 features", package 1, rule 13): the engine's modules load through
// pigment://, pen pointer events reach the stroke with their tilt, twist and wheel (Chromium's pointer events, no
// command-line switch), and Shift+Alt+P, which main.js takes before the page on Windows and Linux, toggles the
// airbrush while a painting tool is active.
import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(new URL('../..', import.meta.url).pathname);

test('pen samples paint through the 0.5 engine, and Shift+Alt+P toggles the airbrush', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'pigment-userdata-'));
  const app = await electron.launch({ args: ['.', '--no-sandbox', '--disable-gpu'], cwd: ROOT, env: { ...process.env, PIGMENT_USER_DATA: userData, ELECTRON_ENABLE_LOGGING: '1' } });
  try {
    const window = await app.firstWindow();
    await window.waitForSelector('body[data-ready]', { timeout: 60_000 });
    await window.evaluate(() => window.pigmentApp.newDocument({ width: 300, height: 200, name: 'Pen', background: 'white' }));
    await window.waitForSelector('.doc-frame:not([hidden]) canvas.view');
    const r = await window.evaluate(async () => {
      const app = window.pigmentApp;
      const { ENGINE } = await import('./lib/brush.js');
      const { setToolBrush } = await import('./lib/brush/tool-brush.js');
      const { normalizeBrush } = await import('./lib/brush/preset.js');
      app.tools.activate('brush');
      app.setColors({ foreground: '#000000' });
      app.tools.setOpt('brush', 'pressureSize', false);
      app.tools.setOpt('brush', 'smoothing', 0);
      setToolBrush(app, 'brush', normalizeBrush({ tip: { size: 40, hardness: 1, roundness: 0.1 }, shapeDynamics: { enabled: true, angleControl: { type: 'rotation', fadeSteps: 25 } } }), { includeTool: false });
      const tool = app.tools.get('brush');
      const seen = [];
      const down = tool.onPointerDown.bind(tool);
      tool.onPointerDown = (p) => {
        seen.push({ pointerType: p.pointerType, tiltX: p.tiltX, twist: p.twist, wheel: p.tangentialPressure, pressure: p.pressure });
        down(p);
      };
      const canvas = document.querySelector('.doc-frame:not([hidden]) canvas.view');
      const rc = canvas.getBoundingClientRect();
      const s = app.view.toScreen(150, 100);
      const o = { bubbles: true, cancelable: true, composed: true, pointerId: 1, pointerType: 'pen', isPrimary: true, clientX: rc.left + s.x, clientY: rc.top + s.y, pressure: 0.7, tiltX: 20, twist: 90, tangentialPressure: 0.5 };
      canvas.dispatchEvent(new PointerEvent('pointerdown', { ...o, button: 0, buttons: 1 }));
      canvas.dispatchEvent(new PointerEvent('pointerup', { ...o, button: 0, buttons: 0 }));
      tool.onPointerDown = down;
      const l = app.doc.active;
      const dark = (x, y) => l.canvas.getContext('2d').getImageData(x - l.x, y - l.y, 1, 1).data[0] < 128;
      return { engine: ENGINE.id, seen, up: dark(150, 115), side: dark(165, 100) };
    });
    expect(r.engine).not.toBe('classic-0.4');
    expect(r.seen).toEqual([{ pointerType: 'pen', tiltX: 20, twist: 90, wheel: 0.5, pressure: expect.closeTo(0.7, 3) }]);
    // the barrel's 90 degrees stood the thin tip up
    expect(r.up).toBe(true);
    expect(r.side).toBe(false);

    // Shift+Alt+P from the native side: the airbrush toggles (Layer > Blend Mode > Pass Through is not run)
    const buildUp = () => window.evaluate(async () => (await import('./lib/brush/tool-brush.js')).toolBrush(window.pigmentApp, 'brush').preset.buildUp);
    expect(await buildUp()).toBe(false);
    await app.evaluate(({ BrowserWindow }) => {
      const wc = BrowserWindow.getAllWindows()[0].webContents;
      wc.focus();
      for (const type of ['keyDown', 'keyUp']) wc.sendInputEvent({ type, keyCode: 'P', modifiers: ['shift', 'alt'] });
    });
    await expect.poll(buildUp, { timeout: 10_000 }).toBe(true);
    expect(await window.evaluate(() => window.pigmentApp.doc.active.blend ?? window.pigmentApp.doc.active.blendMode ?? 'normal')).not.toBe('pass-through');
  } finally {
    // the painted document is unsaved: without this, closing would wait on the "save changes?" question
    await app.windows()[0]?.evaluate(() => window.pigmentApp.docs.list().forEach((d) => d.history.markSaved())).catch(() => {});
    await app.close().catch(() => {});
    rmSync(userData, { recursive: true, force: true });
  }
});
