// psd-layers (ARCHITECTURE.md "0.5 features", package 5) in the Electron runtime: the renderer's ag-psd bundle under
// pigment:// carries psd-layers' handler fixes (scripts/vendor-entries/ag-psd-layers.js), so a PSD given on the command
// line opens with its Deep knockout, its one restricted channel, its shape layer and its Bevel & Emboss texture depth,
// and saving it writes them back.
import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(new URL('../..', import.meta.url).pathname);

/** A small PSD as Photoshop writes these features (layer records without pixels: ag-psd in Node has no canvas). */
async function photoshopPsd(dir) {
  const ag = await import('#ag-psd');
  const k = (x, y) => ({ linked: false, points: [x, y, x, y, x, y] });
  const pattern = { name: 'Dots', id: 'dots-1', x: 0, y: 0, bounds: { x: 0, y: 0, w: 2, h: 2 }, data: new Uint8Array([255, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 0, 0, 255]) };
  const bytes = ag.writePsdUint8Array({
    width: 40, height: 30, patterns: [pattern],
    children: [
      { name: 'Knocked', left: 0, top: 0, right: 0, bottom: 0, knockout: true, knockoutMode: 'deep', channelBlendingRestrictions: [2],
        effects: { bevel: { enabled: true, present: true, style: 'inner bevel', size: { units: 'Pixels', value: 4 }, useTexture: true, pattern: { name: 'Dots', id: 'dots-1' } } },
        effectsExtra: { bevel: [{ textureDepth: { $type: 'UntF', units: 'Percent', value: 40 }, InvT: { $type: 'bool', value: true } }] } },
      { name: 'Shape', left: 0, top: 0, right: 0, bottom: 0, vectorFill: { type: 'color', color: { r: 255, g: 0, b: 0 } },
        vectorStroke: { strokeEnabled: false, fillEnabled: true, lineWidth: { units: 'Points', value: 1 }, lineDashOffset: { units: 'Points', value: 0 }, miterLimit: 4, lineCapType: 'butt', lineJoinType: 'miter', lineAlignment: 'center', lineDashSet: [], blendMode: 'normal', opacity: 1, content: { type: 'color', color: { r: 0, g: 0, b: 0 } }, resolution: 72 },
        vectorMask: { paths: [{ open: false, operation: 'combine', fillRule: 'non-zero', knots: [k(5, 5), k(30, 5), k(30, 25), k(5, 25)] }] } },
    ],
  }, { noBackground: true });
  const path = join(dir, 'ps.psd');
  writeFileSync(path, bytes);
  return path;
}

test('the packaged renderer\'s ag-psd carries the layer fixes: a Photoshop PSD opens and saves with them', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'pigment-userdata-'));
  const dir = mkdtempSync(join(tmpdir(), 'pigment-psd-'));
  const file = await photoshopPsd(dir);
  const app = await electron.launch({ args: ['.', '--no-sandbox', '--disable-gpu', file], cwd: ROOT, env: { ...process.env, PIGMENT_USER_DATA: userData } });
  try {
    const window = await app.firstWindow();
    const problems = [];
    window.on('console', (m) => m.type() === 'error' && problems.push(m.text()));
    await window.waitForSelector('body[data-ready]', { timeout: 60_000 });
    expect(window.url()).toMatch(/^pigment:/);
    await expect.poll(() => window.evaluate(() => window.pigmentApp.doc?.layers().length ?? 0), { timeout: 30_000 }).toBe(2);
    const r = await window.evaluate(async () => {
      const ag = await import('#ag-psd');
      const io = await import('/lib/io.js');
      const d = window.pigmentApp.doc;
      const k = d.layers().find((l) => l.name === 'Knocked');
      const s = d.layers().find((l) => l.name === 'Shape');
      const raw = ag.readPsd(io.writePsdDocument(d, d.view.compositor, { notices: false }), { skipThumbnail: true, skipCompositeImageData: true, skipLayerImageData: true });
      const rk = raw.children.find((c) => c.name === 'Knocked');
      return {
        patched: ag.fixesPatched.layers,
        read: { knockout: k.blending?.knockout, channels: k.blending?.channels, depth: k.styles?.bevel?.texture?.depth ?? null, invert: k.styles?.bevel?.texture?.invert ?? null, shape: s.type, fill: s.fill?.color },
        written: { knockout: rk.knockoutMode, restricted: rk.channelBlendingRestrictions, shape: !!raw.children.find((c) => c.name === 'Shape').vectorStroke },
      };
    });
    expect(r.patched).toBe(true);
    expect(r.read).toEqual({ knockout: 'deep', channels: { r: true, g: true, b: false }, depth: 0.4, invert: true, shape: 'shape', fill: '#ff0000' });
    expect(r.written).toEqual({ knockout: 'deep', restricted: [2], shape: true });
    expect(problems).toEqual([]);
  } finally {
    await app.close().catch(() => {});
    rmSync(userData, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});
