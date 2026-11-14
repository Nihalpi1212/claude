// The preset store's files through the real main process (ARCHITECTURE.md "0.4 features", C): pigment.presets.* over
// IPC writes <userData>/presets/<kind>.json and side files, validates kinds and names, and renames a corrupt file.
import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(new URL('../..', import.meta.url).pathname);

test('presets: write, read, blob round trip, invalid kind rejected, corrupt file renamed, the store loads it', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'pigment-userdata-'));
  // a corrupt contours file left by an earlier session
  mkdirSync(join(userData, 'presets'), { recursive: true });
  writeFileSync(join(userData, 'presets', 'contours.json'), '{ broken');
  const app = await electron.launch({ args: ['.', '--no-sandbox', '--disable-gpu'], cwd: ROOT, env: { ...process.env, PIGMENT_USER_DATA: userData, ELECTRON_ENABLE_LOGGING: '1' } });
  try {
    const window = await app.firstWindow();
    await window.waitForSelector('body[data-ready]', { timeout: 60_000 });
    const dir = join(userData, 'presets');

    // write and read a kind's file (a kind with a colon is stored with __)
    const file = { format: 'pigment-presets', version: 1, kind: 'adjustment:levels', kindVersion: 1, groups: [], items: [{ id: 'u-1', name: 'Mine', group: null, data: { gamma: 1.2 }, builtin: false }], hidden: [] };
    await window.evaluate((f) => window.pigment.presets.write('adjustment:levels', f), file);
    expect(JSON.parse(readFileSync(join(dir, 'adjustment__levels.json'), 'utf8'))).toEqual(file);
    expect(await window.evaluate(() => window.pigment.presets.read('adjustment:levels'))).toEqual(file);
    expect(await window.evaluate(() => window.pigment.presets.read('styles'))).toBeNull();

    // a blob round trip byte for byte, then removed
    const bytes = [0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255];
    await window.evaluate((b) => window.pigment.presets.writeBlob('patterns', 'p-1.png', new Uint8Array(b)), bytes);
    expect(Array.from(readFileSync(join(dir, 'patterns', 'p-1.png')))).toEqual(bytes);
    expect(await window.evaluate(async () => Array.from(await window.pigment.presets.readBlob('patterns', 'p-1.png')))).toEqual(bytes);
    await window.evaluate(() => window.pigment.presets.removeBlob('patterns', 'p-1.png'));
    expect(existsSync(join(dir, 'patterns', 'p-1.png'))).toBe(false);

    // invalid kinds and names are rejected, and nothing is written outside the folder
    const rejected = await window.evaluate(async () => {
      const out = [];
      for (const call of [() => window.pigment.presets.write('../evil', {}), () => window.pigment.presets.read('A'), () => window.pigment.presets.writeBlob('patterns', '../x', new Uint8Array(1)), () => window.pigment.presets.write('gradients', [1])]) {
        try {
          await call();
          out.push('accepted');
        } catch (err) {
          out.push(/Invalid|must be an object/.test(String(err?.message)) ? 'rejected' : String(err?.message));
        }
      }
      return out;
    });
    expect(rejected).toEqual(['rejected', 'rejected', 'rejected', 'rejected']);
    expect(existsSync(join(userData, 'evil.json'))).toBe(false);

    // the corrupt file is renamed when read; the store then shows the built-ins only (Linear and, once
    // layer-style-effects has landed, Photoshop's other contours)
    const contours = await window.evaluate(async () => {
      await window.pigmentApp.presets.ready('contours');
      return window.pigmentApp.presets.list('contours').map((p) => ({ name: p.name, builtin: !!p.builtin }));
    });
    expect(contours.map((c) => c.name)).toContain('Linear');
    expect(contours.filter((c) => !c.builtin)).toEqual([]);
    expect(readdirSync(dir).some((n) => /^contours\.json\.corrupt-\d+$/.test(n))).toBe(true);

    // the store writes through IPC: a user gradient lands in gradients.json after the debounce
    await window.evaluate(async () => {
      await window.pigmentApp.presets.ready('gradients');
      window.pigmentApp.presets.add('gradients', { name: 'Electron test', data: { stops: [{ pos: 0, color: '#ff0000' }, { pos: 1, color: '#00ff00' }] } });
      await window.pigmentApp.presets.flush();
    });
    const saved = JSON.parse(readFileSync(join(dir, 'gradients.json'), 'utf8'));
    expect(saved.format).toBe('pigment-presets');
    expect(saved.items.some((i) => i.name === 'Electron test')).toBe(true);

    // the clipboard text comes back through the bridge
    await app.evaluate(({ clipboard }) => clipboard.writeText('pigment clipboard'));
    expect(await window.evaluate(() => window.pigment.readClipboardText())).toBe('pigment clipboard');
  } finally {
    await app.close().catch(() => {});
    rmSync(userData, { recursive: true, force: true });
  }
});
