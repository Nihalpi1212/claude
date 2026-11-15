// type-editing (0.4, package 2) in the packaged app: the hidden input of the Type tool editor receives keys sent
// through the window's native input path (where the menu accelerators also live), and the clipboard goes through the
// preload bridge to the system clipboard (writeClipboardText, readClipboardText). Each key acts once: an accelerator
// the editor handled is not run a second time by the menu (B.8).
import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(new URL('../..', import.meta.url).pathname);

test('typing, the system clipboard (formatted copy and paste, Paste Without Formatting from the menu) and undo once per key', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'pigment-userdata-'));
  const app = await electron.launch({ args: ['.', '--no-sandbox', '--disable-gpu'], cwd: ROOT, env: { ...process.env, PIGMENT_USER_DATA: userData, ELECTRON_ENABLE_LOGGING: '1' } });
  try {
    const window = await app.firstWindow();
    await window.waitForSelector('body[data-ready]', { timeout: 60_000 });
    await window.evaluate(() => window.pigmentApp.newDocument({ width: 400, height: 300, name: 'Type' }));
    await window.waitForSelector('.doc-frame:not([hidden]) canvas.view');
    await window.evaluate(async () => {
      const app = window.pigmentApp;
      const { TextLayer } = await import('./lib/document.js');
      const M = await import('./lib/type/model.js');
      // the stub engine draws with Canvas whatever fonts the machine has
      (await import('./lib/type/api.js')).setEngine('canvas');
      const content = M.applyChar(M.fromPlain('Hello', { size: 40, color: '#ff0000' }), 3, 5, { color: '#0000ff' });
      const layer = new TextLayer({ content, x: 20, y: 40 });
      app.doc.add(layer);
      app.doc.setActive(layer);
      window.__seen = [];
      app.commands.observe({ before: (id, arg, source) => ({ id, source }), after: (t, r, info) => window.__seen.push([t.id, t.source, info.handledBy]) });
      await app.commands.run('layer:edit-text', undefined, 'api');
    });
    await expect.poll(() => window.evaluate(() => document.activeElement?.className)).toBe('type-input');
    const key = (keyCode, modifiers = []) =>
      app.evaluate(({ BrowserWindow }, [k, m]) => {
        const wc = BrowserWindow.getAllWindows()[0].webContents;
        wc.focus();
        wc.sendInputEvent({ type: 'keyDown', keyCode: k, modifiers: m });
        if (!m.length && k.length === 1) wc.sendInputEvent({ type: 'char', keyCode: k });
        wc.sendInputEvent({ type: 'keyUp', keyCode: k, modifiers: m });
      }, [keyCode, modifiers]);
    const text = () => window.evaluate(() => window.pigmentApp.tools.active.session.layer.text);
    const runs = () => window.evaluate(() => window.pigmentApp.tools.active.session.layer.content.runs.map((r) => [r.len, r.style.color]));

    // Ctrl+C copies "Hello" (two runs) to the system clipboard
    await key('C', ['control']);
    await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe('Hello');
    // End, then Ctrl+V: the in-app clipboard still matches the system text, so both colours come back
    await key('End');
    await key('V', ['control']);
    await expect.poll(text).toBe('HelloHello');
    expect(await runs()).toEqual([[3, '#ff0000'], [2, '#0000ff'], [3, '#ff0000'], [2, '#0000ff']]);
    // another application copied: Ctrl+V pastes its text in the style at the caret
    await app.evaluate(({ clipboard }) => clipboard.writeText('Other'));
    await key('V', ['control']);
    await expect.poll(text).toBe('HelloHelloOther');
    expect((await runs()).at(-1)).toEqual([7, '#0000ff']);
    // Edit > Paste Special > Paste Without Formatting, clicked in the menu: no paste event, readClipboardText (O)
    await app.evaluate(({ Menu }) => {
      const find = (items, label) => {
        for (const it of items) {
          if (it.label?.replace('&', '') === label) return it;
          const sub = it.submenu && find(it.submenu.items, label);
          if (sub) return sub;
        }
        return null;
      };
      find(Menu.getApplicationMenu().items, 'Paste Without Formatting').click(undefined, undefined, undefined);
    });
    await expect.poll(text).toBe('HelloHelloOtherOther');
    // one Ctrl+Z undoes one paste: the menu's Undo accelerator did not run a second time
    await key('Z', ['control']);
    await expect.poll(text).toBe('HelloHelloOther');
    await window.waitForTimeout(200);
    expect(await text()).toBe('HelloHelloOther');
    // typing through the native input path, then Shift+Ctrl+L aligns left instead of running Auto Tone
    await key('x');
    await expect.poll(text).toBe('HelloHelloOtherx');
    await window.evaluate(async () => (await import('./lib/type/target.js')).applyPara(window.pigmentApp, { align: 'center' }));
    await key('L', ['control', 'shift']);
    await expect.poll(() => window.evaluate(() => window.pigmentApp.tools.active.session.layer.content.paras[0].style.align ?? 'left')).toBe('left');
    const ran = await window.evaluate(() => window.__seen.filter(([id, , by]) => id === 'image:auto-tone' && !by));
    expect(ran).toEqual([]);
    // Ctrl+Enter commits: one history entry for the session
    await key('Enter', ['control']);
    await expect.poll(() => window.evaluate(() => !!window.pigmentApp.tools.active.session)).toBe(false);
    expect(await window.evaluate(() => window.pigmentApp.doc.history.entries.at(-1).label)).toBe('Edit Type Layer');
    // nothing to save: closing the window must not ask
    await window.evaluate(() => window.pigmentApp.docs.list().forEach((d) => d.history.markSaved()));
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});
