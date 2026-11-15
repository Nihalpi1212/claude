// type-menu-commands (ARCHITECTURE.md "0.5 features", package 13; port 8863): Warp Text, the anti-aliasing methods,
// Create Work Path, Convert to Shape, Convert to Point / Paragraph Text, Update All Text Layers, Paste Lorem Ipsum,
// the orientation button and the two Type Mask tools. The text uses the bundled SourceSans3VF (drawn by HarfBuzz, so
// it has glyph outlines); Arial in a plain Chromium run has no installed face and is drawn by the Canvas engine.
import { test, expect } from '@playwright/test';
import { openApp, newDoc, runAwait, run, confirmDialog } from './helpers.mjs';

const VF = 'SourceSans3VF';

/** Adds a text layer through the model, selects it and waits for HarfBuzz to draw it; returns its id. */
async function addText(page, { text = 'Hob', char = {}, x = 40, y = 60, width = null, height = null, typeOptions = null, family = VF } = {}) {
  const id = await page.evaluate(async ({ t, c, px, py, w, h, to, fam }) => {
    const app = window.pigmentApp;
    const { TextLayer } = await import('/lib/document.js');
    const M = await import('/lib/type/model.js');
    const layer = new TextLayer({ content: M.fromPlain(t, { size: 64, color: '#204080', fontFamily: fam, ...c }), x: px, y: py, width: w, ...(to ? { typeOptions: to } : {}) });
    if (h !== null) layer.height = h;
    app.doc.add(layer);
    app.doc.setActive(layer);
    app.doc.changed('tree');
    return layer.id;
  }, { t: text, c: char, px: x, py: y, w: width, h: height, to: typeOptions, fam: family });
  if (family === VF) await expect.poll(() => page.evaluate((lid) => window.pigmentApp.doc.find(lid).layout().engine, id)).toBe('harfbuzz');
  return id;
}
/** The number of contours HarfBuzz gives for a text in the bundled family (fonts.js harfBuzzFontProvider.outline). */
const contourCount = (page, text) => page.evaluate(async ([t, vf]) => {
  const { harfBuzzFontProvider } = await import('/lib/type/fonts.js');
  const M = await import('/lib/type/model.js');
  return harfBuzzFontProvider.outline(M.resolveChar({ fontFamily: vf, size: 64 }), t).subpaths.length;
}, [text, VF]);
const labels = (page, from) => page.evaluate((n) => window.pigmentApp.doc.history.entries.slice(n + 1, window.pigmentApp.doc.history.index + 1).map((e) => e.label), from);
const historyIndex = (page) => page.evaluate(() => window.pigmentApp.doc.history.index);
/** The layer's render (document space): its box, the alpha values present and a checksum of the pixels. */
const renderOf = (page, id) => page.evaluate((lid) => {
  const l = window.pigmentApp.doc.find(lid);
  l.touch();
  const r = l.render();
  const d = r.canvas.getContext('2d').getImageData(0, 0, r.canvas.width, r.canvas.height).data;
  const alphas = new Set();
  let ink = 0, sum = 0;
  for (let i = 0; i < d.length; i += 4) {
    alphas.add(d[i + 3]);
    if (d[i + 3]) ink++;
    sum = (sum * 31 + d[i] + d[i + 1] * 3 + d[i + 2] * 7 + d[i + 3] * 11) % 1000000007;
  }
  // the ink's own box (the render is padded)
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (let y = 0; y < r.canvas.height; y++) for (let x = 0; x < r.canvas.width; x++) if (d[(y * r.canvas.width + x) * 4 + 3] > 127) {
    x1 = Math.min(x1, x);
    x2 = Math.max(x2, x);
    y1 = Math.min(y1, y);
    y2 = Math.max(y2, y);
  }
  return { x: r.x, y: r.y, w: r.canvas.width, h: r.canvas.height, alphas: [...alphas].sort((a, b) => a - b), ink, sum, inkBox: [x1 + r.x, y1 + r.y, x2 + r.x, y2 + r.y] };
}, id);

test('the package landed: no stub left, the two Type Mask tools follow the Type tools in the text slot', async ({ page }) => {
  const errors = await openApp(page);
  const r = await page.evaluate(async () => {
    const app = window.pigmentApp;
    const { typeTools } = await import('/lib/tools/text.js');
    return {
      stubbed: app.stubbed.filter((id) => /^type:(anti-alias|warp-text|create-work-path|convert-to-shape|convert-text-kind|update-all|paste-lorem-ipsum|toggle-orientation)$|^tool:type-mask/.test(id)),
      slot: app.tools.slots.find((s) => s.id === 'text').tools,
      types: typeTools(app).map((t) => [t.id, t.vertical, t.mask, t.sibling?.id ?? null]),
      icons: [app.tools.get('type-mask-horizontal').icon, app.tools.get('type-mask-vertical').icon],
    };
  });
  expect(r.stubbed).toEqual([]);
  expect(r.slot).toEqual(['type-horizontal', 'type-vertical', 'type-mask-vertical', 'type-mask-horizontal']);
  expect(r.types).toEqual([
    ['type-horizontal', false, false, 'type-vertical'], ['type-vertical', true, false, 'type-horizontal'],
    ['type-mask-vertical', true, true, 'type-mask-horizontal'], ['type-mask-horizontal', false, true, 'type-mask-vertical'],
  ]);
  expect(r.icons).toEqual(['type-mask', 'type-mask-vertical']);
  // Shift+T cycles all four
  await newDoc(page);
  await page.evaluate(() => window.pigmentApp.tools.activate('type-horizontal'));
  await page.locator('canvas.view').hover();
  const seen = [];
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press('Shift+KeyT');
    seen.push(await page.evaluate(() => window.pigmentApp.tools.active.id));
  }
  expect(seen).toEqual(['type-vertical', 'type-mask-vertical', 'type-mask-horizontal', 'type-horizontal']);
  expect(errors).toEqual([]);
});

test('Warp Text: a live warp in one entry that bends the pixels, undoes, survives .pigment and replays from an action', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 500, height: 300 });
  const id = await addText(page, { text: 'Warped' });
  const plain = await renderOf(page, id);
  const n = await historyIndex(page);
  await runAwait(page, 'type:warp-text', { style: 'arc', bend: 60 });
  expect(await labels(page, n)).toEqual(['Warp Text']);
  const warped = await renderOf(page, id);
  expect(await page.evaluate((lid) => window.pigmentApp.doc.find(lid).typeOptions.warp, id)).toEqual({ style: 'arc', horizontal: true, bend: 60, hDistort: 0, vDistort: 0 });
  // Arc lifts the middle of the line: the ink reaches higher than the straight text, its ends stay near
  expect(warped.inkBox[1]).toBeLessThan(plain.inkBox[1] - 10);
  expect(warped.sum).not.toBe(plain.sum);
  // the layer's bounds hold the warped ink
  const b = await page.evaluate((lid) => window.pigmentApp.doc.find(lid).bounds(), id);
  expect(b.y).toBeLessThanOrEqual(warped.inkBox[1]);
  expect(b.x + b.width).toBeGreaterThanOrEqual(warped.inkBox[2]);
  await runAwait(page, 'edit:undo');
  expect((await renderOf(page, id)).sum).toBe(plain.sum);
  await runAwait(page, 'edit:redo');
  expect((await renderOf(page, id)).sum).toBe(warped.sum);
  // .pigment keeps the warp, and the reopened text draws the same pixels
  const back = await page.evaluate(async (lid) => {
    const app = window.pigmentApp;
    const io = await import('/lib/io.js');
    const doc2 = await io.readPigment(await io.writePigment(app.doc));
    const l = doc2.layers().find((x) => x.type === 'text');
    const r = l.render();
    const d = r.canvas.getContext('2d').getImageData(0, 0, r.canvas.width, r.canvas.height).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum = (sum * 31 + d[i] + d[i + 1] * 3 + d[i + 2] * 7 + d[i + 3] * 11) % 1000000007;
    return { warp: l.typeOptions.warp, sum, same: app.doc.find(lid).typeOptions.warp };
  }, id);
  expect(back.warp).toEqual(back.same);
  expect(back.sum).toBe(warped.sum);
  // Vertical, and None removes the warp (one entry each)
  const m = await historyIndex(page);
  await runAwait(page, 'type:warp-text', { style: 'flag', horizontal: false, bend: 30, hDistort: 10 });
  await runAwait(page, 'type:warp-text', { style: 'none' });
  expect(await labels(page, m)).toEqual(['Warp Text', 'Warp Text']);
  expect(await page.evaluate((lid) => 'warp' in window.pigmentApp.doc.find(lid).typeOptions, id)).toBe(false);
  expect((await renderOf(page, id)).sum).toBe(plain.sum);
  // an action records the warp the command applied and replays it
  const steps = await page.evaluate(async () => {
    const app = window.pigmentApp;
    const a = app.actions.newAction({ name: 'Warp' });
    app.actions.record(a);
    app.commands.run('type:warp-text', { style: 'wave', bend: 40 }, 'api');
    app.commands.run('type:anti-alias', 'crisp', 'api');
    app.actions.stopRecording();
    window.__warpAction = a.id;
    return a.steps.map((s) => [s.command, s.arg]);
  });
  expect(steps).toEqual([['type:warp-text', { style: 'wave', horizontal: true, bend: 40, hDistort: 0, vDistort: 0 }], ['type:anti-alias', 'crisp']]);
  await runAwait(page, 'edit:undo');
  await runAwait(page, 'edit:undo');
  const played = await page.evaluate(async (lid) => {
    const app = window.pigmentApp;
    try {
      const res = await app.actions.play(window.__warpAction);
      const l = app.doc.find(lid);
      return { ok: res.ok, warp: l.typeOptions.warp?.style ?? null, aa: l.typeOptions.antiAlias };
    } finally {
      await new Promise((r) => setTimeout(r, 0));
    }
  }, id);
  expect(played).toEqual({ ok: true, warp: 'wave', aa: 'crisp' });
  expect(errors).toEqual([]);
});

test('Warp Text dialog: the options bar button opens it, OK is one entry with the chosen style, Cancel changes nothing', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 500, height: 300 });
  const id = await addText(page, { text: 'Dialog' });
  await page.evaluate(() => window.pigmentApp.tools.activate('type-horizontal'));
  const n = await historyIndex(page);
  await page.locator('#options-bar .opt[data-key="warpText"] button').click();
  await expect(page.locator('.dialog select[data-key="style"]')).toBeVisible();
  await page.locator('.dialog select[data-key="style"]').selectOption('bulge');
  // the preview shows on the canvas before OK, without a history entry
  await expect.poll(() => page.evaluate((lid) => window.pigmentApp.doc.find(lid).typeOptions.warp?.style ?? null, id)).toBe('bulge');
  expect(await labels(page, n)).toEqual([]);
  await confirmDialog(page);
  expect(await labels(page, n)).toEqual(['Warp Text']);
  expect(await page.evaluate((lid) => window.pigmentApp.doc.find(lid).typeOptions.warp, id)).toEqual({ style: 'bulge', horizontal: true, bend: 50, hDistort: 0, vDistort: 0 });
  // reopened: the dialog shows the layer's warp; Cancel reverts the preview
  await run(page, 'type:warp-text');
  await expect(page.locator('.dialog select[data-key="style"]')).toHaveValue('bulge');
  await page.locator('.dialog select[data-key="style"]').selectOption('twist');
  await expect.poll(() => page.evaluate((lid) => window.pigmentApp.doc.find(lid).typeOptions.warp?.style ?? null, id)).toBe('twist');
  await page.keyboard.press('Escape');
  await expect(page.locator('.dialog-backdrop')).toHaveCount(0);
  expect(await page.evaluate((lid) => window.pigmentApp.doc.find(lid).typeOptions.warp?.style ?? null, id)).toBe('bulge');
  expect(await labels(page, n)).toEqual(['Warp Text']);
  // text on a path is never warped
  const onPath = await page.evaluate(async (lid) => {
    const app = window.pigmentApp;
    const l = app.doc.find(lid);
    l.pathText = { path: { subpaths: [{ closed: false, points: [{ x: 20, y: 200 }, { x: 400, y: 200 }] }] }, startOffset: 0, flip: false, align: 'left' };
    l.touch();
    const before = app.doc.history.index;
    app.commands.run('type:warp-text', { style: 'arc' }, 'api');
    return { entries: app.doc.history.index - before, toast: document.querySelector('.toast')?.textContent ?? '' };
  }, id);
  expect(onPath.entries).toBe(0);
  expect(onPath.toast).toContain('text on a path');
  expect(errors).toEqual([]);
});

test('Anti-Alias None gives only 0 and 255 alpha, also warped, after Free Transform and on vertical text; one entry from the menu, the bar and the panel', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 500, height: 400 });
  const id = await addText(page, { text: 'Crisp' });
  const smooth = await renderOf(page, id);
  expect(smooth.alphas.length).toBeGreaterThan(20);
  const n = await historyIndex(page);
  await runAwait(page, 'type:anti-alias', 'none');
  expect(await labels(page, n)).toEqual(['Anti-Alias']);
  const none = await renderOf(page, id);
  expect(none.alphas).toEqual([0, 255]);
  // the same letters: the ink box of None is the smooth ink box within a pixel
  for (let i = 0; i < 4; i++) expect(Math.abs(none.inkBox[i] - smooth.inkBox[i])).toBeLessThanOrEqual(1);
  // Sharp, Crisp and Strong shape the coverage: fewer partial pixels than Smooth, Strong the most ink
  const counts = {};
  for (const m of ['sharp', 'crisp', 'strong']) {
    await runAwait(page, 'type:anti-alias', m);
    counts[m] = await renderOf(page, id);
  }
  expect(counts.sharp.alphas.length).toBeLessThan(smooth.alphas.length);
  expect(counts.strong.ink).toBeGreaterThan(counts.crisp.ink - 1);
  expect(await page.evaluate(() => window.pigmentApp.uiState?.antiAlias ?? null)).toBe('strong');
  await runAwait(page, 'type:anti-alias', 'none');
  // warped
  await runAwait(page, 'type:warp-text', { style: 'arc', bend: 50 });
  const warped = await renderOf(page, id);
  expect(warped.alphas).toEqual([0, 255]);
  expect(warped.inkBox[1]).toBeLessThan(none.inkBox[1] - 5);
  // after Free Transform (rotated and scaled: the stage draws in document space, nothing is resampled)
  await page.evaluate((lid) => {
    const app = window.pigmentApp;
    const c = Math.cos(0.4) * 1.3, s = Math.sin(0.4) * 1.3;
    app.commands.run('layer:select', lid, 'api');
    const l = app.doc.find(lid);
    l.transform = [c, s, -s, c, 120, -40];
    l.touch();
  }, id);
  const turned = await renderOf(page, id);
  expect(turned.alphas).toEqual([0, 255]);
  expect(turned.w).toBeGreaterThan(warped.w);
  // a vertical text layer (rotated by its transform)
  const vid = await addText(page, { text: 'Vert', x: 400, y: 20, typeOptions: { orientation: 'vertical', antiAlias: 'none' } });
  await page.evaluate((lid) => {
    const l = window.pigmentApp.doc.find(lid);
    l.transform = [0, 1, -1, 0, l.x + l.y, l.y - l.x];
    l.touch();
  }, vid);
  expect((await renderOf(page, vid)).alphas).toEqual([0, 255]);
  // the options bar's select and the Character panel's select run the command: one "Anti-Alias" entry each
  await page.evaluate((lid) => {
    const app = window.pigmentApp;
    app.doc.setActive(app.doc.find(lid));
    app.tools.activate('type-horizontal');
  }, id);
  const m = await historyIndex(page);
  await page.locator('#options-bar .opt[data-key="antiAlias"] select').selectOption('sharp');
  await expect.poll(() => page.evaluate((lid) => window.pigmentApp.doc.find(lid).typeOptions.antiAlias, id)).toBe('sharp');
  expect(await labels(page, m)).toEqual(['Anti-Alias']);
  await runAwait(page, 'window:panel-character');
  const panelSelect = page.locator('select[data-k="antiAlias"]:visible').first();
  await expect(panelSelect).toBeVisible();
  await panelSelect.selectOption('crisp');
  await expect.poll(() => page.evaluate((lid) => window.pigmentApp.doc.find(lid).typeOptions.antiAlias, id)).toBe('crisp');
  expect(await labels(page, m)).toEqual(['Anti-Alias', 'Anti-Alias']);
  // Canvas-engine text (no outlines) is shaped from its own drawing: None is still 0 or 255
  const cid = await addText(page, { text: 'Arial', family: 'Arial', x: 40, y: 250, typeOptions: { antiAlias: 'none' } });
  expect(await page.evaluate((lid) => window.pigmentApp.doc.find(lid).layout().engine, cid)).toBe('canvas');
  expect((await renderOf(page, cid)).alphas).toEqual([0, 255]);
  expect(errors).toEqual([]);
});

test('Create Work Path: a subpath per glyph contour, warp and transform included, one entry; the Canvas engine says why it cannot', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 500, height: 300 });
  const id = await addText(page, { text: 'Hob' });
  const n = await historyIndex(page);
  await runAwait(page, 'type:create-work-path');
  expect(await labels(page, n)).toEqual(['Create Work Path']);
  const wp = await page.evaluate((lid) => {
    const d = window.pigmentApp.doc;
    const l = d.find(lid);
    const pts = d.workPath.subpaths.flatMap((s) => s.points);
    return { count: d.workPath.subpaths.length, closed: d.workPath.subpaths.every((s) => s.closed), x1: Math.min(...pts.map((p) => p.x)), y1: Math.min(...pts.map((p) => p.y)), x2: Math.max(...pts.map((p) => p.x)), y2: Math.max(...pts.map((p) => p.y)), bounds: l.bounds() };
  }, id);
  // H 1, o 2, b 2 contours
  expect(wp.count).toBe(5);
  expect(wp.count).toBe(await contourCount(page, 'Hob'));
  expect(wp.closed).toBe(true);
  const ink = (await renderOf(page, id)).inkBox;
  expect(Math.abs(wp.x1 - ink[0])).toBeLessThan(1.5);
  expect(Math.abs(wp.y1 - ink[1])).toBeLessThan(1.5);
  expect(Math.abs(wp.x2 - ink[2] - 1)).toBeLessThan(1.5);
  await runAwait(page, 'edit:undo');
  expect(await page.evaluate(() => window.pigmentApp.doc.workPath?.subpaths?.length ?? 0)).toBe(0);
  // warped and moved by its transform: the path follows the drawing
  await runAwait(page, 'type:warp-text', { style: 'arc', bend: 60 });
  await page.evaluate((lid) => {
    const l = window.pigmentApp.doc.find(lid);
    l.transform = [1, 0, 0, 1, 30, 20];
    l.touch();
  }, id);
  await runAwait(page, 'type:create-work-path');
  const warped = await page.evaluate(() => {
    const pts = window.pigmentApp.doc.workPath.subpaths.flatMap((s) => s.points);
    return [Math.min(...pts.map((p) => p.x)), Math.min(...pts.map((p) => p.y)), Math.max(...pts.map((p) => p.x)), Math.max(...pts.map((p) => p.y))];
  });
  const wink = (await renderOf(page, id)).inkBox;
  expect(Math.abs(warped[1] - wink[1])).toBeLessThan(2);
  expect(Math.abs(warped[0] - wink[0])).toBeLessThan(2);
  // text drawn by the Canvas engine has no outlines: a message, no entry
  const cid = await addText(page, { text: 'Arial', family: 'Arial', y: 200 });
  const m = await historyIndex(page);
  const msg = await page.evaluate(async () => {
    window.pigmentApp.commands.run('type:create-work-path', undefined, 'api');
    window.pigmentApp.commands.run('type:convert-to-shape', undefined, 'api');
    return [...document.querySelectorAll('.toast')].map((t) => t.textContent).join(' | ');
  });
  expect(msg).toContain('has no glyph outlines');
  expect(await labels(page, m)).toEqual([]);
  expect(await page.evaluate((lid) => window.pigmentApp.doc.find(lid)?.type, cid)).toBe('text');
  expect(errors).toEqual([]);
});

test('Convert to Shape: the text layer becomes a shape of its outlines in its place, one entry, undo brings the text back', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 500, height: 300 });
  const id = await addText(page, { text: 'Shape', char: { color: '#c02020' } });
  await page.evaluate((lid) => {
    const l = window.pigmentApp.doc.find(lid);
    l.opacity = 0.6;
    l.blend = 'multiply';
  }, id);
  await addText(page, { text: 'Above', y: 180 });
  await page.evaluate((lid) => window.pigmentApp.doc.setActive(window.pigmentApp.doc.find(lid)), id);
  const before = await page.evaluate(() => window.pigmentApp.doc.layers().map((l) => [l.type, l.name]));
  const ink = (await renderOf(page, id)).inkBox;
  const n = await historyIndex(page);
  await runAwait(page, 'type:convert-to-shape');
  expect(await labels(page, n)).toEqual(['Convert to Shape']);
  const r = await page.evaluate(() => {
    const d = window.pigmentApp.doc;
    const l = d.active;
    const b = l.bounds();
    return { layers: d.layers().map((x) => [x.type, x.name]), type: l.type, fill: l.fill, opacity: l.opacity, blend: l.blend, subpaths: l.path.subpaths.length, b };
  });
  expect(r.layers).toEqual(before.map(([t, name]) => [name === 'Shape' ? 'shape' : t, name]));
  expect(r).toMatchObject({ type: 'shape', fill: { type: 'solid', color: '#c02020' }, opacity: 0.6, blend: 'multiply' });
  expect(r.subpaths).toBe(await contourCount(page, 'Shape'));
  expect(Math.abs(r.b.x - ink[0])).toBeLessThan(3);
  expect(Math.abs(r.b.y - ink[1])).toBeLessThan(3);
  await runAwait(page, 'edit:undo');
  expect(await page.evaluate(() => window.pigmentApp.doc.layers().map((l) => [l.type, l.name]))).toEqual(before);
  expect(await page.evaluate((lid) => window.pigmentApp.doc.find(lid)?.type, id)).toBe('text');
  expect(errors).toEqual([]);
});

test('Convert to Paragraph / Point Text: the box fits the text; wrapped lines become returns; the menu label follows', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 600, height: 400 });
  const id = await addText(page, { text: 'One two three four five six', width: 200, char: { size: 32 } });
  const lines = await page.evaluate((lid) => window.pigmentApp.doc.find(lid).layout().lines.length, id);
  expect(lines).toBeGreaterThan(1);
  expect(await page.evaluate(() => window.pigmentApp.uiState?.textKind)).toBe('paragraph');
  const before = await renderOf(page, id);
  const n = await historyIndex(page);
  await runAwait(page, 'type:convert-text-kind');
  expect(await labels(page, n)).toEqual(['Convert to Point Text']);
  const point = await page.evaluate((lid) => {
    const l = window.pigmentApp.doc.find(lid);
    return { width: l.width, text: l.text, lines: l.layout().lines.length };
  }, id);
  expect(point.width).toBe(null);
  expect(point.lines).toBe(lines);
  expect(point.text.split('\n').length).toBe(lines);
  expect(point.text.replace(/\n/g, ' ')).toBe('One two three four five six');
  // the lines stay where they were drawn
  const after = await renderOf(page, id);
  for (let i = 0; i < 4; i++) expect(Math.abs(after.inkBox[i] - before.inkBox[i])).toBeLessThanOrEqual(1);
  expect(await page.evaluate(() => window.pigmentApp.uiState?.textKind)).toBe('point');
  // and back: a box wide enough for the lines, nothing wraps again
  await runAwait(page, 'type:convert-text-kind', 'paragraph');
  const para = await page.evaluate((lid) => {
    const l = window.pigmentApp.doc.find(lid);
    return { width: l.width, lines: l.layout().lines.length };
  }, id);
  expect(para.width).toBeGreaterThan(50);
  expect(para.lines).toBe(lines);
  expect(await labels(page, n)).toEqual(['Convert to Point Text', 'Convert to Paragraph Text']);
  await runAwait(page, 'edit:undo');
  await runAwait(page, 'edit:undo');
  expect(await page.evaluate((lid) => [window.pigmentApp.doc.find(lid).width, window.pigmentApp.doc.find(lid).text], id)).toEqual([200, 'One two three four five six']);
  expect(errors).toEqual([]);
});

test('Paste Lorem Ipsum while editing; Update All Text Layers; the orientation button switches the text and the tool', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 600, height: 400 });
  expect(await page.evaluate(() => window.pigmentApp.commands.isEnabled('type:paste-lorem-ipsum'))).toBe(false);
  const n = await historyIndex(page);
  await page.evaluate((vf) => {
    const app = window.pigmentApp;
    app.tools.activate('type-horizontal');
    app.tools.setOpt('type-horizontal', 'family', vf);
    app.tools.active.beginNew({ x: 30, y: 30 }, { x: 30, y: 30, width: 300, height: 200 });
  }, VF);
  expect(await page.evaluate(() => window.pigmentApp.commands.isEnabled('type:paste-lorem-ipsum'))).toBe(true);
  await runAwait(page, 'type:paste-lorem-ipsum');
  const filled = await page.evaluate(() => {
    const t = window.pigmentApp.tools.active;
    const l = t.session.layer;
    return { text: l.text, overflow: l.layout().overflow };
  });
  expect(filled.text.startsWith('Lorem ipsum dolor sit amet')).toBe(true);
  // a fixed box is filled to its end
  expect(filled.overflow).toBe(true);
  await page.evaluate(() => window.pigmentApp.tools.active.commitSession());
  expect(await labels(page, n)).toEqual(['Horizontal Type Tool']);
  // Update All: no entry, the text layers are laid out again
  const m = await historyIndex(page);
  const count = await runAwait(page, 'type:update-all');
  expect(count).toBe(1);
  expect(await labels(page, m)).toEqual([]);
  // the orientation button: the active text turns vertical (one entry) and the tool follows
  const id = await page.evaluate(() => window.pigmentApp.doc.active.id);
  await page.locator('#options-bar .opt[data-key="orientationToggle"] button').click();
  await expect.poll(() => page.evaluate((lid) => window.pigmentApp.doc.find(lid).font.orientation ?? 'horizontal', id)).toBe('vertical');
  expect(await page.evaluate(() => window.pigmentApp.tools.active.id)).toBe('type-vertical');
  expect(await labels(page, m)).toEqual(['Text Orientation']);
  await runAwait(page, 'type:toggle-orientation');
  expect(await page.evaluate((lid) => window.pigmentApp.doc.find(lid).font.orientation ?? 'horizontal', id)).toBe('horizontal');
  expect(await page.evaluate(() => window.pigmentApp.tools.active.id)).toBe('type-horizontal');
  // with no text layer the button only switches the tool
  await runAwait(page, 'layer:new');
  await runAwait(page, 'type:toggle-orientation');
  expect(await page.evaluate(() => window.pigmentApp.tools.active.id)).toBe('type-vertical');
  expect(errors).toEqual([]);
});

test('Type Mask: typing makes a selection in one entry, no layer left; Shift adds; None makes a hard-edged one; undo', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 400, height: 300 });
  const layers = await page.evaluate(() => window.pigmentApp.doc.layers().length);
  const n = await historyIndex(page);
  await page.evaluate((vf) => {
    const app = window.pigmentApp;
    app.tools.activate('type-mask-horizontal');
    app.tools.setOpt('type-mask-horizontal', 'family', vf);
    app.tools.setOpt('type-mask-horizontal', 'size', 72);
  }, VF);
  // a click on the canvas starts the text; typing goes into it
  const box = await page.locator('canvas.view').boundingBox();
  const at = await page.evaluate(() => window.pigmentApp.view.toScreen(40, 150));
  await page.mouse.click(box.x + at.x, box.y + at.y);
  await expect.poll(() => page.evaluate(() => !!window.pigmentApp.tools.active.session)).toBe(true);
  await page.keyboard.type('Mask');
  const during = await page.evaluate(() => {
    const s = window.pigmentApp.tools.active.session;
    return { text: s.layer.text, opacity: s.layer.opacity, layers: window.pigmentApp.doc.layers().length };
  });
  expect(during).toEqual({ text: 'Mask', opacity: 0, layers: layers + 1 });
  await page.keyboard.press('Control+Enter');
  await expect.poll(() => page.evaluate(() => !!window.pigmentApp.tools.active.session)).toBe(false);
  const r = await page.evaluate(() => {
    const d = window.pigmentApp.doc;
    return { layers: d.layers().length, bounds: d.selection?.bounds ?? null };
  });
  expect(r.layers).toBe(layers);
  expect(r.bounds).not.toBe(null);
  expect(r.bounds.x).toBeGreaterThanOrEqual(38);
  expect(r.bounds.y + r.bounds.height).toBeLessThanOrEqual(152);
  expect(await labels(page, n)).toEqual(['Type Mask']);
  // the vertical tool with None and Shift: the selection grows, its new part has hard edges
  const m = await historyIndex(page);
  const v = await page.evaluate((vf) => {
    const app = window.pigmentApp;
    app.tools.activate('type-mask-vertical');
    app.tools.setOpt('type-mask-vertical', 'family', vf);
    app.tools.setOpt('type-mask-vertical', 'antiAlias', 'none');
    const t = app.tools.active;
    t.maskMode = 'add';
    t.beginNew({ x: 300, y: 20 }, null);
    t.session.editor.insert('V');
    t.commitSession();
    const sel = app.doc.selection;
    const part = [];
    for (let y = 0; y < sel.height; y++) for (let x = 250; x < sel.width; x++) part.push(sel.mask[y * sel.width + x]);
    return { values: [...new Set(part)].sort((a, b) => a - b), bounds: sel.bounds };
  }, VF);
  expect(v.values).toEqual([0, 255]);
  expect(v.bounds.x).toBe(r.bounds.x);
  expect(v.bounds.x + v.bounds.width).toBeGreaterThan(280);
  expect(await labels(page, m)).toEqual(['Type Mask']);
  await runAwait(page, 'edit:undo');
  expect(await page.evaluate(() => window.pigmentApp.doc.selection?.bounds ?? null)).toEqual(r.bounds);
  // Escape cancels: nothing changes
  const k = await historyIndex(page);
  await page.evaluate(() => {
    const t = window.pigmentApp.tools.active;
    t.beginNew({ x: 200, y: 20 }, null);
    t.session.editor.insert('X');
    t.cancelSession();
  });
  expect(await labels(page, k)).toEqual([]);
  expect(await page.evaluate(() => window.pigmentApp.doc.layers().length)).toBe(layers);
  expect(errors).toEqual([]);
});

test('16-bit Grayscale and CMYK documents: warp, anti-alias, work path and Type Mask work and draw', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 400, height: 300 });
  await runAwait(page, 'image:mode', { mode: 'grayscale', silent: true, flatten: false });
  await runAwait(page, 'image:depth', 16);
  expect(await page.evaluate(() => [window.pigmentApp.doc.mode, window.pigmentApp.doc.depth])).toEqual(['grayscale', 16]);
  const id = await addText(page, { text: 'Deep' });
  await runAwait(page, 'type:warp-text', { style: 'flag', bend: 40 });
  await runAwait(page, 'type:anti-alias', 'none');
  expect((await renderOf(page, id)).alphas).toEqual([0, 255]);
  await runAwait(page, 'type:create-work-path');
  expect(await page.evaluate(() => window.pigmentApp.doc.workPath.subpaths.length)).toBe(await contourCount(page, 'Deep'));
  // the composite shows the warped text
  const ink = await page.evaluate(() => {
    const d = window.pigmentApp.doc;
    const c = d.view.compositor.composite(d);
    const px = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let dark = 0;
    for (let i = 0; i < px.length; i += 4) if (px[i] < 128) dark++;
    return dark;
  });
  expect(ink).toBeGreaterThan(200);
  await runAwait(page, 'image:mode', { mode: 'cmyk', silent: true, flatten: false });
  expect(await page.evaluate(() => window.pigmentApp.doc.mode)).toBe('cmyk');
  await runAwait(page, 'type:convert-to-shape');
  expect(await page.evaluate(() => window.pigmentApp.doc.active.type)).toBe('shape');
  const sel = await page.evaluate((vf) => {
    const app = window.pigmentApp;
    app.tools.activate('type-mask-horizontal');
    app.tools.setOpt('type-mask-horizontal', 'family', vf);
    const t = app.tools.active;
    t.beginNew({ x: 30, y: 250 }, null);
    t.session.editor.insert('Ink');
    t.commitSession();
    return app.doc.selection?.bounds ?? null;
  }, VF);
  expect(sel).not.toBe(null);
  expect(errors).toEqual([]);
});

test('PSD: warped and None text saves and reopens; the text survives (the warp and method travel once psd-text maps them)', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 400, height: 300 });
  await addText(page, { text: 'Psd', typeOptions: { antiAlias: 'none' } });
  await runAwait(page, 'type:warp-text', { style: 'arc', bend: 30 });
  const r = await page.evaluate(async () => {
    const app = window.pigmentApp;
    const io = await import('/lib/io.js');
    const { psdFeatures } = await import('/lib/psd/registry.js');
    const back = io.readPsdDocument(io.writePsdDocument(app.doc, app.view.compositor));
    const l = back.layers().find((x) => x.name === 'Psd');
    return { type: l?.type ?? null, text: l?.text ?? null, warp: l?.typeOptions?.warp?.style ?? null, aa: l?.typeOptions?.antiAlias ?? null, textRuns: !!psdFeatures().textRuns };
  });
  expect(r.type === 'text' || r.type === 'raster').toBe(true);
  if (r.type === 'text') expect(r.text).toBe('Psd');
  expect(errors).toEqual([]);
});

test('Type Mask in an action: the selection is recorded as Set Selection and replays', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 400, height: 300 });
  const r = await page.evaluate(async (vf) => {
    const app = window.pigmentApp;
    const a = app.actions.newAction({ name: 'Mask' });
    app.actions.record(a);
    app.tools.activate('type-mask-horizontal');
    app.tools.setOpt('type-mask-horizontal', 'family', vf);
    const t = app.tools.active;
    t.beginNew({ x: 40, y: 150 }, null);
    t.session.editor.insert('Act');
    t.commitSession();
    await new Promise((res) => setTimeout(res, 50));
    app.actions.stopRecording();
    const bounds = app.doc.selection.bounds;
    app.commands.run('select:none', undefined, 'api');
    try {
      const res = await app.actions.play(a.id);
      return { steps: a.steps.map((s) => s.command), ok: res.ok, bounds, after: app.doc.selection?.bounds ?? null };
    } finally {
      await new Promise((res) => setTimeout(res, 0));
    }
  }, VF);
  expect(r.steps).toEqual(['actions:set-selection']);
  expect(r.ok).toBe(true);
  expect(r.after).toEqual(r.bounds);
  expect(errors).toEqual([]);
});
