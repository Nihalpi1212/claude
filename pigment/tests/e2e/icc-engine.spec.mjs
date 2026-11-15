// icc-engine (ARCHITECTURE.md "0.5 features", package 4; port 8854): colour profiles through LittleCMS. Files with a
// profile keep their numbers and the profile, every file Pigment writes embeds it again, Assign Profile is one history
// entry that survives .pigment, the view shows a tagged document converted for the display (and an untagged or sRGB
// one exactly as 0.4), and Convert to sRGB converts.
import { test, expect } from '@playwright/test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openApp, newDoc, run, runAwait, confirmDialog } from './helpers.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Page helpers: canvases of known numbers, encoders, a tagger and readers of what the document holds. */
async function helpers(page) {
  await page.evaluate(async () => {
    const { writeChunks, readChunks } = await import('/lib/io-chunks.js');
    const { builtinIcc } = await import('/lib/color/profiles.js');
    const P = await import('/lib/color/pipeline.js');
    await P.colorEngine().ready();
    const blobBytes = async (canvas, type, q) => new Uint8Array(await (await new Promise((res) => canvas.toBlob(res, type, q))).arrayBuffer());
    window.__icc = {
      P,
      readChunks,
      builtinIcc,
      /** A canvas of four flat quarters: colours whose P3 and sRGB numbers differ. */
      canvas(w = 64, h = 48, colours = ['#c86432', '#3296c8', '#40c040', '#808080']) {
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        const g = c.getContext('2d');
        colours.forEach((col, i) => {
          g.fillStyle = col;
          g.fillRect((i % 2) * (w / 2), Math.floor(i / 2) * (h / 2), w / 2, h / 2);
        });
        return c;
      },
      png: (c) => blobBytes(c, 'image/png'),
      jpeg: (c, q = 0.95) => blobBytes(c, 'image/jpeg', q),
      tag: (bytes, format, icc) => writeChunks(bytes, format, { icc: typeof icc === 'string' ? builtinIcc(icc) : icc }),
      async open(path, bytes) {
        window.__pigmentTest.files[path] = bytes;
        await window.pigmentApp.commands.run('file:open-paths', [path], 'api');
        await new Promise((r) => setTimeout(r, 0));
        return window.pigmentApp.doc;
      },
      data: (c) => Array.from(c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height).data),
      layerData: (doc = window.pigmentApp.doc) => window.__icc.data(doc.layers()[0].canvas),
      async decodeNone(bytes, type) {
        const bm = await createImageBitmap(new Blob([bytes], { type }), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
        const c = document.createElement('canvas');
        c.width = bm.width;
        c.height = bm.height;
        c.getContext('2d').drawImage(bm, 0, 0);
        return window.__icc.data(c);
      },
      same: (a, b) => a.length === b.length && a.every((v, i) => v === b[i]),
      async icc(bytes, format) {
        const ch = await readChunks(bytes, format);
        return ch.icc ? Array.from(ch.icc) : null;
      },
      frame: () => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res))),
    };
  });
}

test('a Display P3 PNG and JPEG keep their numbers and their profile; untagged and sRGB-tagged files open as 0.4 opened them', async ({ page }) => {
  const errors = await openApp(page);
  await helpers(page);
  const r = await page.evaluate(async () => {
    const H = window.__icc;
    const c = H.canvas();
    const stored = H.data(c);
    const out = {};
    // PNG: lossless, so the document holds exactly the numbers that were written
    let d = await H.open('mem:/p3.png', await H.tag(await H.png(c), 'png', 'display-p3'));
    out.png = { profile: d.profile?.name, id: d.profile?.id, kept: H.same(H.layerData(d), stored), described: H.P.describe(d) };
    // another maker's Display P3 (other bytes, the same space) is its own profile, named by the SHA-1 of its bytes
    const PR = await import('/lib/color/profiles.js');
    const other = PR.writeIcc({ ...PR.BUILTIN_DEFS[1], name: 'Display P3 (another maker)', legacy: true });
    d = await H.open('mem:/other-p3.png', await H.tag(await H.png(c), 'png', other));
    out.other = { profile: d.profile?.name, id: d.profile?.id, wellKnown: d.profile?.wellKnown, kept: H.same(H.layerData(d), stored) };
    // JPEG: the numbers the decoder gives without conversion
    const jpeg = await H.tag(await H.jpeg(c), 'jpeg', 'display-p3');
    d = await H.open('mem:/p3.jpg', jpeg);
    const none = await H.decodeNone(jpeg, 'image/jpeg');
    out.jpeg = { profile: d.profile?.name, kept: H.same(H.layerData(d), none) };
    // an untagged PNG and an sRGB-tagged JPEG: 0.4's decoding; the sRGB one is recorded as sRGB (no bytes)
    d = await H.open('mem:/plain.png', await H.png(c));
    out.untagged = { profile: d.profile, kept: H.same(H.layerData(d), stored), described: H.P.describe(d) };
    const srgbIcc = (await import('/lib/color/profiles.js')).writeIcc({ ...(await import('/lib/color/profiles.js')).BUILTIN_DEFS[0], name: 'sRGB from a camera' });
    d = await H.open('mem:/srgb.jpg', await H.tag(await H.jpeg(c), 'jpeg', srgbIcc));
    out.srgb = { id: d.profile?.id, bytes: d.profile?.bytes ?? null, described: H.P.describe(d) };
    // a Gray profile on a grey JPEG is adopted; the numbers stay
    const g = H.canvas(32, 32, ['#404040', '#808080', '#c0c0c0', '#202020']);
    d = await H.open('mem:/grey.jpg', await H.tag(await H.jpeg(g), 'jpeg', 'gray-gamma-2.2'));
    out.gray = { profile: d.profile?.name, space: d.profile?.colorSpace };
    return out;
  });
  // Pigment's own Display P3 bytes are the built-in
  expect(r.png).toEqual({ profile: 'Display P3', id: 'display-p3', kept: true, described: 'Display P3' });
  expect(r.other).toMatchObject({ profile: 'Display P3 (another maker)', wellKnown: 'display-p3', kept: true });
  expect(r.other.id).toMatch(/^[0-9a-f]{40}$/);
  expect(r.jpeg).toEqual({ profile: 'Display P3', kept: true });
  expect(r.untagged).toEqual({ profile: null, kept: true, described: 'Untagged RGB' });
  expect(r.srgb).toEqual({ id: 'srgb', bytes: null, described: 'sRGB IEC61966-2.1' });
  expect(r.gray).toEqual({ profile: 'Gray Gamma 2.2', space: 'gray' });
  expect(errors).toEqual([]);
});

test('a soft-alpha palette PNG with a P3 profile is converted once: its numbers are the palette\'s', async ({ page }) => {
  const errors = await openApp(page);
  await helpers(page);
  const r = await page.evaluate(async () => {
    const H = window.__icc;
    const { encodePng } = await import('/shared/pixels/png.js');
    const idx = await encodePng({ width: 2, height: 2, channels: 1, depth: 8, data: Uint8Array.of(0, 1, 1, 0), palette: Uint8Array.of(200, 100, 50, 50, 150, 200), transparency: Uint8Array.of(255, 255) }, { indexed: true });
    // a second palette entry with partial alpha makes it a soft-alpha palette (the browser decoder reads it)
    const soft = await encodePng({ width: 2, height: 2, channels: 1, depth: 8, data: Uint8Array.of(0, 1, 1, 0), palette: Uint8Array.of(200, 100, 50, 50, 150, 200), transparency: Uint8Array.of(255, 200) }, { indexed: true });
    const out = {};
    for (const [name, bytes] of [['opaque', idx], ['soft', soft]]) {
      const d = await H.open(`mem:/${name}.png`, await H.tag(bytes, 'png', 'display-p3'));
      const px = H.layerData(d).slice(0, 8);
      out[name] = { profile: d.profile?.name ?? null, first: px.slice(0, 3), second: px.slice(4, 7) };
    }
    return out;
  });
  for (const k of ['opaque', 'soft']) {
    expect(r[k].profile, k).toBe('Display P3');
    expect(r[k].first, k).toEqual([200, 100, 50]);
    expect(r[k].second, k).toEqual([50, 150, 200]);
  }
  expect(errors).toEqual([]);
});

test('every format, Export As, Quick Export, Export Layers and Save for Web embed the document\'s profile again', async ({ page }) => {
  const errors = await openApp(page);
  await helpers(page);
  const r = await page.evaluate(async () => {
    const H = window.__icc;
    const T = window.__pigmentTest;
    const app = window.pigmentApp;
    const P3 = H.builtinIcc('display-p3');
    const d = await H.open('mem:/in.png', await H.tag(await H.png(H.canvas()), 'png', 'display-p3'));
    const io = await import('/lib/io.js');
    const comp = d.view.compositor;
    const has = async (bytes, f) => {
      const icc = await H.icc(bytes, f);
      return !!icc && icc.length === P3.length && icc.every((v, i) => v === P3[i]);
    };
    const out = {};
    for (const [ext, f] of [['png', 'png'], ['jpg', 'jpeg'], ['webp', 'webp'], ['psd', 'psd']]) out[ext] = await has(await io.encodeForPath(d, `x.${ext}`, comp, { quality: 0.9 }), f);
    for (const id of ['png16', 'tiff']) {
      const fmt = io.SAVE_FORMATS[id];
      if (fmt) out[id] = await has(await io.exportImage(d, { format: id }, comp), id === 'png16' ? 'png' : 'tiff');
    }
    // through the commands
    T.nextSavePath = 'mem:/saved.png';
    await app.commands.run('file:save-as', undefined, 'api');
    out.saveAs = await has(T.written['mem:/saved.png'], 'png');
    await app.commands.run('file:export', { path: 'mem:/exported.jpg', format: 'jpeg', quality: 0.9, width: 64, height: 48 }, 'api');
    out.exportAs = await has(T.written['mem:/exported.jpg'], 'jpeg');
    T.nextSavePath = 'mem:/quick.png';
    await app.commands.run('file:export-quick', undefined, 'api');
    out.quick = await has(T.written[Object.keys(T.written).find((k) => /quick|saved copy|in\.png$/.test(k) && k !== 'mem:/saved.png') ?? 'mem:/quick.png'], 'png');
    T.nextDirectory = 'mem:/layers';
    await app.commands.run('file:export-layers', { format: 'png', visibleOnly: true, trim: false, prefix: 'L_', folder: 'mem:/layers' }, 'api');
    const layerFile = Object.keys(T.written).find((k) => k.startsWith('mem:/layers/'));
    out.layers = layerFile ? await has(T.written[layerFile], 'png') : null;
    await app.commands.run('layer:export-quick', { folder: 'mem:/quick-layers' }, 'api');
    const ql = Object.keys(T.written).find((k) => k.startsWith('mem:/quick-layers/'));
    out.quickLayers = ql ? await has(T.written[ql], 'png') : null;
    // Save for Web: unticked Convert to sRGB embeds the profile; ticked (the default) converts and embeds nothing
    await app.commands.run('file:save-for-web', { path: 'mem:/web-kept.png', format: 'png24', width: 64, height: 48, quality: 80, transparency: true, srgb: false }, 'api');
    out.webKept = await has(T.written['mem:/web-kept.png'], 'png');
    await app.commands.run('file:save-for-web', { path: 'mem:/web.png', format: 'png24', width: 64, height: 48, quality: 80, transparency: true }, 'api');
    out.webConverted = await H.icc(T.written['mem:/web.png'], 'png');
    out.embedFalse = await H.icc(await io.exportImage(d, { format: 'png', embedProfile: false }, comp), 'png');
    return out;
  });
  expect(r).toMatchObject({ png: true, jpg: true, webp: true, psd: true, saveAs: true, exportAs: true, quick: true, layers: true, quickLayers: true, webKept: true });
  if ('png16' in r) expect(r.png16).toBe(true);
  if ('tiff' in r) expect(r.tiff).toBe(true);
  expect(r.webConverted).toBeNull();
  expect(r.embedFalse).toBeNull();
  expect(errors).toEqual([]);
});

test('Convert to sRGB in Save for Web converts the numbers; an untagged document is written as 0.4 wrote it', async ({ page }) => {
  const errors = await openApp(page);
  await helpers(page);
  const r = await page.evaluate(async () => {
    const H = window.__icc;
    const T = window.__pigmentTest;
    const app = window.pigmentApp;
    const { decodePng, toRgba8 } = await import('/shared/pixels/png.js');
    const c = H.canvas(64, 48);
    const stored = H.data(c);
    await H.open('mem:/in.png', await H.tag(await H.png(c), 'png', 'display-p3'));
    await app.commands.run('file:save-for-web', { path: 'mem:/web.png', format: 'png24', width: 64, height: 48, quality: 80, transparency: true }, 'api');
    const img = toRgba8(await decodePng(T.written['mem:/web.png']));
    const px = Array.from(img.data.slice(0, 4));
    const expected = H.P.convertColor(stored.slice(0, 3), H.P.colorEngine().profileById('display-p3'), H.P.SRGB);
    // untagged: byte-identical to the stub's path (no conversion, no chunk)
    await H.open('mem:/plain.png', await H.png(c));
    await app.commands.run('file:save-for-web', { path: 'mem:/web-plain.png', format: 'png24', width: 64, height: 48, quality: 80, transparency: true }, 'api');
    const plain = toRgba8(await decodePng(T.written['mem:/web-plain.png']));
    return { stored: stored.slice(0, 3), px, expected, plainSame: H.same(Array.from(plain.data), stored), plainIcc: await H.icc(T.written['mem:/web-plain.png'], 'png') };
  });
  expect(r.px.slice(0, 3)).not.toEqual(r.stored);
  r.px.slice(0, 3).forEach((v, i) => expect(Math.abs(v - r.expected[i])).toBeLessThanOrEqual(1));
  expect(r.plainSame).toBe(true);
  expect(r.plainIcc).toBeNull();
  expect(errors).toEqual([]);
});

test('Assign Profile: the dialog, one entry that undoes, the status bar, .pigment, an action replay; Don\'t Color Manage', async ({ page }) => {
  const errors = await openApp(page);
  await helpers(page);
  await newDoc(page, { width: 40, height: 30 });
  expect(await page.locator('#statusbar [data-key="profile"]').textContent()).toBe('Untagged RGB');
  await run(page, 'edit:assign-profile');
  const dlg = page.locator('.dialog-backdrop .dialog').last();
  await expect(dlg).toContainText('Assign Profile');
  await dlg.locator('select[data-key="choice"]').selectOption('profile');
  await dlg.locator('select[data-key="profile"]').selectOption('adobe-rgb');
  await confirmDialog(page);
  const r = await page.evaluate(async () => {
    const app = window.pigmentApp;
    const d = app.doc;
    const io = await import('/lib/io.js');
    const out = { profile: d.profile?.id, label: d.history.entries.at(-1).label, status: document.querySelector('#statusbar [data-key="profile"]')?.textContent };
    const n = d.history.entries.length;
    d.history.undo();
    out.undone = d.profile;
    out.statusUndone = document.querySelector('#statusbar [data-key="profile"]')?.textContent;
    d.history.redo();
    out.redone = d.profile?.id;
    const back = await io.readPigment(await io.writePigment(d));
    out.pigment = { id: back.profile?.id, name: back.profile?.name, bytes: back.profile?.bytes?.length ?? 0 };
    // replayed with its argument: no dialog; null is Don't Color Manage
    await app.commands.run('edit:assign-profile', { profile: 'display-p3' }, 'action');
    out.replayed = d.profile?.id;
    await app.commands.run('edit:assign-profile', { profile: null }, 'action');
    out.none = d.profile;
    out.entries = d.history.entries.length - n;
    // working RGB: the sRGB built-in, which embeds nothing
    await app.commands.run('edit:assign-profile', { profile: 'srgb' }, 'action');
    out.working = { id: d.profile?.id, described: (await import('/lib/color/pipeline.js')).describe(d) };
    return out;
  });
  expect(r).toMatchObject({ profile: 'adobe-rgb', label: 'Assign Profile', status: 'Adobe RGB (1998)-compatible', undone: null, statusUndone: 'Untagged RGB', redone: 'adobe-rgb', replayed: 'display-p3', none: null, entries: 2 });
  expect(r.pigment).toMatchObject({ id: 'adobe-rgb', name: 'Adobe RGB (1998)-compatible' });
  expect(r.pigment.bytes).toBeGreaterThan(300);
  expect(r.working).toEqual({ id: 'srgb', described: 'sRGB IEC61966-2.1' });
  // the action recorder kept the dialog's choice as the argument
  expect(errors).toEqual([]);
});

test('Assign Profile records its choice for actions, and a 0.4 .pigment opens untagged', async ({ page }) => {
  const errors = await openApp(page);
  await helpers(page);
  await newDoc(page, { width: 20, height: 20 });
  const seen = await page.evaluate(() => {
    const app = window.pigmentApp;
    const evs = (window.__done = []);
    app.on('command:done', (e) => e.id === 'edit:assign-profile' && evs.push({ arg: e.arg, replayable: e.replayable }));
    return true;
  });
  expect(seen).toBe(true);
  await run(page, 'edit:assign-profile');
  const dlg = page.locator('.dialog-backdrop .dialog').last();
  await dlg.locator('select[data-key="choice"]').selectOption('profile');
  await dlg.locator('select[data-key="profile"]').selectOption('prophoto');
  await confirmDialog(page);
  await expect.poll(() => page.evaluate(() => window.__done)).toEqual([{ arg: { profile: 'prophoto' }, replayable: true }]);
  // a .pigment written by 0.4 has no profile: its description has none and there is no profile.icc entry
  const r = await page.evaluate(async () => {
    const io = await import('/lib/io.js');
    const { readZip, writeZip, streamCodecs } = await import('/shared/zip.js');
    const d = window.pigmentApp.doc;
    const entries = await readZip(await io.writePigment(d), { inflate: streamCodecs.inflate });
    const strip = [];
    for (const e of entries) {
      if (e.name === 'profile.icc') continue;
      if (e.name === 'document.json') {
        const desc = JSON.parse(new TextDecoder().decode(e.data));
        delete desc.profile;
        strip.push({ name: e.name, data: new TextEncoder().encode(JSON.stringify(desc)) });
      } else strip.push({ name: e.name, data: e.data });
    }
    const old = await io.readPigment(await writeZip(strip, { deflate: streamCodecs.deflate }));
    return { names: entries.map((e) => e.name), profile: old.profile };
  });
  expect(r.names).toContain('profile.icc');
  expect(r.profile).toBeNull();
  expect(errors).toEqual([]);
});

test('the view shows a P3 document converted for the display and an untagged one exactly; painting with the Info panel open updates the view', async ({ page }) => {
  const errors = await openApp(page);
  await helpers(page);
  const r = await page.evaluate(async () => {
    const H = window.__icc;
    const app = window.pigmentApp;
    const D = await import('/lib/color/display.js');
    const flat = H.canvas(200, 150, ['#c86432', '#c86432', '#c86432', '#c86432']);
    // the view's own pixel at the document's centre, once the view has painted (it fits the window first)
    const viewPixel = async (view) => {
      for (let i = 0; i < 60; i++) {
        await H.frame();
        const p = view.toScreen(100, 75);
        const dpr = view.dpr ?? 1;
        const px = Array.from(view.ctx.getImageData(Math.round(p.x * dpr), Math.round(p.y * dpr), 1, 1).data);
        if (px[3] === 255) return px;
      }
      return null;
    };
    const out = {};
    let d = await H.open('mem:/plain.png', await H.png(flat));
    await H.frame();
    out.untagged = { view: await viewPixel(d.view), active: D.stageActive(d.view, () => true), kept: !!D.keptCanvas(d.view) };
    d = await H.open('mem:/p3.png', await H.tag(await H.png(flat), 'png', 'display-p3'));
    await H.frame();
    out.p3 = { space: d.view.space, view: await viewPixel(d.view), expected: H.P.convertColor([200, 100, 50], d.profile, H.P.SRGB), active: D.stageActive(d.view, () => true) };
    // paint with the Info panel open (it composites for its readout between the view's paints)
    await app.commands.run('window:panel-info', undefined, 'api');
    D.resetDisplayStats();
    await app.commands.run('tool:brush', undefined, 'api');
    app.setColors({ foreground: '#2040ff' });
    return out;
  });
  expect(r.untagged.view.slice(0, 3)).toEqual([200, 100, 50]);
  expect(r.untagged.active).toBe(false);
  expect(r.untagged.kept).toBe(false);
  expect(r.p3.space).toBe('srgb'); // the test browser's screen is sRGB
  expect(r.p3.active).toBe(true);
  expect(r.p3.view.slice(0, 3)).not.toEqual([200, 100, 50]);
  r.p3.view.slice(0, 3).forEach((v, i) => expect(Math.abs(v - r.p3.expected[i])).toBeLessThanOrEqual(1));
  // a brush stroke on the P3 document
  const box = await page.locator('.doc-frame:not([hidden]) canvas.view').boundingBox();
  const at = await page.evaluate(() => {
    const v = window.pigmentApp.view;
    const r = v.canvas.getBoundingClientRect();
    const a = v.toScreen(40, 75), b = v.toScreen(160, 75);
    return { a: { x: r.left + a.x, y: r.top + a.y }, b: { x: r.left + b.x, y: r.top + b.y } };
  });
  expect(box).toBeTruthy();
  await page.mouse.move(at.a.x, at.a.y);
  await page.mouse.down();
  await page.mouse.move(at.b.x, at.b.y, { steps: 10 });
  await page.mouse.up();
  const after = await page.evaluate(async () => {
    const H = window.__icc;
    const D = await import('/lib/color/display.js');
    await H.frame();
    const d = window.pigmentApp.doc;
    const comp = d.view.compositor.composite(d);
    const kept = D.keptCanvas(d.view);
    const t = H.P.colorEngine().transform(d.profile, H.P.SRGB);
    const want = comp.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, d.width, d.height);
    t.apply(want.data, want.data, d.width * d.height);
    const got = kept.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, d.width, d.height).data;
    let wrong = 0;
    for (let i = 0; i < got.length; i++) if (Math.abs(got[i] - want.data[i]) > 1) wrong++;
    const s = D.displayStats();
    return { wrong, regions: s.region, fulls: s.full, label: d.history.entries.at(-1).label, infoOpen: !!document.querySelector('.info-panel') };
  });
  expect(after.label).toMatch(/Brush/);
  expect(after.infoOpen).toBe(true);
  expect(after.wrong).toBe(0);
  expect(after.regions).toBeGreaterThan(0);
  expect(after.fulls).toBe(0); // only the damage is converted after the first paint
  expect(errors).toEqual([]);
});

test('display stage: a 2000 x 2000 damage converts within the S6.4 budget (measured and reported)', async ({ page }) => {
  const errors = await openApp(page);
  await helpers(page);
  const r = await page.evaluate(async () => {
    const H = window.__icc;
    const D = await import('/lib/color/display.js');
    const c = document.createElement('canvas');
    c.width = 2000;
    c.height = 2000;
    const g = c.getContext('2d');
    // photo-like: a gradient with noise, so no two neighbours repeat
    const img = g.createImageData(2000, 2000);
    for (let i = 0, s = 7; i < img.data.length; i += 4) {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      const p = i >> 2, x = p % 2000, y = (p / 2000) | 0;
      img.data[i] = (x * 255) / 2000 + (s & 15);
      img.data[i + 1] = (y * 255) / 2000 + ((s >> 4) & 15);
      img.data[i + 2] = ((x + y) * 255) / 4000 + ((s >> 8) & 15);
      img.data[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    const d = await H.open('mem:/big.png', await H.tag(await H.png(c), 'png', 'display-p3'));
    await H.frame();
    const times = [];
    for (let k = 0; k < 6; k++) {
      d.view.compositor.noteDamage({ x: 0, y: 0, width: 2000, height: 2000 });
      d.view.invalidate();
      await H.frame();
      times.push(D.displayStats().last);
    }
    return times.filter(Boolean).map((t) => ({ w: t.w, h: t.h, ms: Math.round(t.ms * 10) / 10 }));
  });
  const ms = r.map((t) => t.ms).sort((a, b) => a - b);
  console.log(`icc-engine display stage, 2000 x 2000 damage: median ${ms[Math.floor(ms.length / 2)]} ms, best ${ms[0]} ms (${ms.join(', ')})`);
  expect(r.length).toBeGreaterThan(3);
  for (const t of r) expect([t.w, t.h]).toEqual([2000, 2000]);
  // a loose bound on a shared machine; the report quotes the measured median
  expect(ms[0]).toBeLessThan(250);
  expect(errors).toEqual([]);
});

test('16-bit PNG, TIFF and PSD keep the profile at the byte level; a Gray-tagged document saves an RGB equivalent', async ({ page }) => {
  const errors = await openApp(page);
  await helpers(page);
  const r = await page.evaluate(async () => {
    const H = window.__icc;
    const app = window.pigmentApp;
    const io = await import('/lib/io.js');
    const P3 = H.builtinIcc('adobe-rgb');
    const out = {};
    let d = await H.open('mem:/in.png', await H.tag(await H.png(H.canvas()), 'png', 'adobe-rgb'));
    const comp = d.view.compositor;
    // PSD: resource 1039 holds the bytes; reopening adopts them
    const psd = await io.encodeForPath(d, 'x.psd', comp);
    out.psdIcc = (await H.icc(psd, 'psd'))?.length === P3.length;
    d = await H.open('mem:/back.psd', psd);
    out.psd = d.profile?.name;
    // 16-bit: the document in 16 bits keeps its profile; its PNG and TIFF carry the bytes and reopen tagged
    await app.commands.run('image:depth', 16, 'api');
    out.depth = app.doc.depth;
    out.described = H.P.describe(app.doc);
    for (const [id, f, ext] of [['png16', 'png', 'png'], ['tiff', 'tiff', 'tif']]) {
      if (!io.SAVE_FORMATS[id]) continue;
      const bytes = await io.exportImage(app.doc, { format: id }, app.doc.view.compositor);
      out[`${id}Icc`] = (await H.icc(bytes, f))?.length === P3.length;
      const back = await H.open(`mem:/back16.${ext}`, bytes);
      out[id] = { profile: back.profile?.name, depth: back.depth };
    }
    // Gray: the document keeps the Gray profile; its files carry an RGB profile with the same tone curve
    d = await H.open('mem:/grey.jpg', await H.tag(await H.jpeg(H.canvas(32, 32, ['#404040', '#808080', '#c0c0c0', '#202020'])), 'jpeg', 'gray-gamma-2.2'));
    const png = await io.encodeForPath(d, 'g.png', d.view.compositor);
    const icc = await H.icc(png, 'png');
    const { parseIcc } = await import('/lib/color/profiles.js');
    const parsed = parseIcc(Uint8Array.from(icc));
    out.grayFile = { space: parsed.space, name: parsed.name, gamma: Math.round(parsed.curves[0].g * 100) / 100 };
    const back = await H.open('mem:/grey-back.png', png);
    out.grayBack = back.profile?.colorSpace;
    // the tones show the same: the Gray profile and its RGB equivalent give the same sRGB numbers
    const t1 = H.P.colorEngine().transform(d.profile, H.P.SRGB), t2 = H.P.colorEngine().transform(back.profile, H.P.SRGB);
    const a = Uint8ClampedArray.of(128, 128, 128, 255), b = Uint8ClampedArray.of(128, 128, 128, 255);
    t1.apply(a, a, 1);
    t2.apply(b, b, 1);
    out.grayShown = [Array.from(a), Array.from(b)];
    return out;
  });
  expect(r.psdIcc).toBe(true);
  expect(r.psd).toBe('Adobe RGB (1998)-compatible');
  expect(r.depth).toBe(16);
  expect(r.described).toBe('Adobe RGB (1998)-compatible (16bpc)');
  if ('png16' in r) expect(r).toMatchObject({ png16Icc: true, png16: { profile: 'Adobe RGB (1998)-compatible', depth: 16 } });
  if ('tiff' in r) expect(r).toMatchObject({ tiffIcc: true, tiff: { profile: 'Adobe RGB (1998)-compatible' } });
  expect(r.grayFile).toEqual({ space: 'rgb', name: 'Gray Gamma 2.2 (RGB)', gamma: 2.2 });
  expect(r.grayBack).toBe('rgb');
  r.grayShown[0].forEach((v, i) => expect(Math.abs(v - r.grayShown[1][i])).toBeLessThanOrEqual(1));
  expect(errors).toEqual([]);
});

test('Preferences: a user profile added from a file is offered by New Document and Assign Profile and kept in the presets', async ({ page }) => {
  const errors = await openApp(page);
  await helpers(page);
  const icc = await page.evaluate(async () => {
    const { writeIcc } = await import('/lib/color/profiles.js');
    const bytes = writeIcc({ name: 'My Wide RGB', space: 'rgb', primaries: [[0.7, 0.29], [0.17, 0.79], [0.14, 0.05]], white: [0.3127, 0.329], trc: { kind: 'gamma', g: 2.0 } });
    window.__pigmentTest.files['browser:/wide.icc'] = bytes;
    window.__pigmentTest.nextOpenFiles = ['browser:/wide.icc'];
    return bytes.length;
  });
  expect(icc).toBeGreaterThan(300);
  await run(page, 'edit:preferences');
  const dlg = page.locator('.dialog-backdrop .dialog').last();
  await expect(dlg).toContainText('Color Management');
  await dlg.locator('.cm-add').click();
  await expect(dlg.locator('.cm-profile-list')).toContainText('My Wide RGB');
  await dlg.locator('select[data-key="cmDisplay"]').selectOption('srgb');
  await confirmDialog(page);
  const r = await page.evaluate(async () => {
    const app = window.pigmentApp;
    const P = await import('/lib/color/pipeline.js');
    const listed = P.profilesList().find((p) => p.name === 'My Wide RGB');
    const stored = app.presets.list('color-profiles').map((p) => ({ name: p.name, colorSpace: p.data.colorSpace, blob: p.data.blob }));
    const blob = await app.presets.readBlob('color-profiles', stored[0].blob);
    return { listed: listed && { source: listed.source, space: listed.colorSpace, id: listed.id }, stored, blob: blob?.length ?? 0, display: app.settings.colorManagement.display };
  });
  expect(r.listed).toMatchObject({ source: 'user', space: 'rgb' });
  expect(r.stored).toEqual([{ name: 'My Wide RGB', colorSpace: 'rgb', blob: `icc-${r.listed.id}.icc` }]);
  expect(r.blob).toBe(icc);
  expect(r.display).toBe('srgb');
  // New Document lists it; a new document made with it is tagged
  await runAwait(page, 'file:new', { width: 30, height: 20, profile: r.listed.id });
  expect(await page.evaluate(() => window.pigmentApp.doc.profile?.name)).toBe('My Wide RGB');
  await expect(page.locator('#statusbar [data-key="profile"]')).toHaveText('My Wide RGB');
  await run(page, 'edit:assign-profile');
  const assign = page.locator('.dialog-backdrop .dialog').last();
  await assign.locator('select[data-key="choice"]').selectOption('profile');
  await expect(assign.locator('select[data-key="profile"] option', { hasText: 'My Wide RGB' })).toHaveCount(1);
  await page.keyboard.press('Escape');
  expect(errors).toEqual([]);
});

test('a launch with a tagged file waits for LittleCMS and opens the file tagged', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  // the wasm arrives late: start-up opens the file before LittleCMS is compiled
  await page.route('**/vendor/lcms2/lcms.wasm', async (route) => {
    await new Promise((res) => setTimeout(res, 1200));
    await route.continue();
  });
  // the file is made here, in Node: a PNG of one colour with the Display P3 profile in its iCCP chunk
  const { encodePng } = await import(join(ROOT, 'src', 'shared', 'pixels', 'png.js'));
  const { writeChunks } = await import(join(ROOT, 'src', 'renderer', 'lib', 'io-chunks.js'));
  const { builtinIcc } = await import(join(ROOT, 'src', 'renderer', 'lib', 'color', 'profiles.js'));
  const rgba = new Uint8Array(16 * 12 * 4).map((_, i) => [200, 100, 50, 255][i % 4]);
  const png = await encodePng({ width: 16, height: 12, channels: 4, depth: 8, data: rgba });
  const bytes = Array.from(await writeChunks(png, 'png', { icc: builtinIcc('display-p3') }));
  await page.addInitScript((data) => {
    window.__pigmentTest = { silent: true, files: { 'mem:/launch.png': new Uint8Array(data) }, written: {}, messages: [], startupFiles: ['mem:/launch.png'] };
    try {
      localStorage.clear();
    } catch {}
  }, bytes);
  await page.goto('/');
  await page.waitForSelector('body[data-ready]');
  const r = await page.evaluate(async () => {
    const P = await import('/lib/color/pipeline.js');
    const L = await import('/lib/color/lcms.js');
    return { profile: window.pigmentApp.doc?.profile?.name ?? null, lcms: !!L.lcms(), described: P.describe(window.pigmentApp.doc) };
  });
  expect(r).toEqual({ profile: 'Display P3', lcms: true, described: 'Display P3' });
  expect(errors).toEqual([]);
});
