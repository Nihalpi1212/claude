// Warp regressions (bug hunt 3): Delete and arrows inside a warp session, layer masks outside the
// warped box, switching between Free Transform and Warp inside one session, Puppet Warp pins added
// after a rotation, H/V idle for None and Custom, Delete in Perspective Warp, collapsed quads, and
// the rasterize prompt for text layers.
import { test, expect } from '@playwright/test';
import { openApp, newDoc, run, runAwait, pixel, drag, screenPoint, historyLength } from './helpers.mjs';

const paint = (page, color, rect) =>
  page.evaluate(([c, r]) => {
    const l = window.pigmentApp.doc.active;
    const ctx = l.canvas.getContext('2d');
    ctx.fillStyle = c;
    ctx.fillRect(...r);
    l.touch();
    window.pigmentApp.doc.changed('pixels', { layer: l });
  }, [color, rect]);

const session = (page) => page.evaluate(() => {
  const tt = window.pigmentApp.transformTool;
  return { active: !!tt.session, warp: tt.warp?.kind ?? null };
});
const labels = (page) => page.evaluate(() => window.pigmentApp.doc.history.entries.slice(0, window.pigmentApp.doc.history.index + 1).map((e) => e.label));
const layerCount = (page) => page.evaluate(() => window.pigmentApp.doc.layers().length);
const red = (p) => p[0] > 200 && p[1] < 60 && p[2] < 60 && p[3] > 200;
const click = async (page, x, y, modifiers = []) => {
  const p = await screenPoint(page, x, y);
  await page.mouse.click(p.x, p.y, { modifiers });
};
const focusCanvas = (page) => page.evaluate(() => document.activeElement?.blur());

test('Delete and Backspace inside warp sessions never apply the warp nor delete or clear the layer', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { background: 'transparent' });
  await runAwait(page, 'layer:new', { name: 'Art' });
  await paint(page, '#ff0000', [100, 100, 200, 100]);
  const n = await historyLength(page);
  // Warp with a preset, then Backspace and Delete
  await runAwait(page, 'edit:transform-warp');
  await page.selectOption('#options-bar select[data-key="warp-preset"]', 'arc');
  await focusCanvas(page);
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Delete');
  expect(await session(page)).toEqual({ active: true, warp: 'bezier' });
  expect(await layerCount(page)).toBe(2);
  await page.keyboard.press('Escape');
  // Puppet Warp: remove the only pin, then Delete again with nothing selected
  await runAwait(page, 'edit:puppet-warp');
  await click(page, 150, 150);
  await expect.poll(() => page.evaluate(() => window.pigmentApp.transformTool.warp.pins.length)).toBe(1);
  await page.keyboard.press('Delete');
  await expect.poll(() => page.evaluate(() => window.pigmentApp.transformTool.warp.pins.length)).toBe(0);
  await page.keyboard.press('Delete');
  await page.keyboard.press('ArrowRight');
  expect(await session(page)).toEqual({ active: true, warp: 'puppet' });
  await page.keyboard.press('Escape');
  // Perspective Warp in warp mode
  await runAwait(page, 'edit:perspective-warp');
  await drag(page, [100, 100], [300, 200]);
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => window.pigmentApp.transformTool.warp?.mode)).toBe('warp');
  await page.keyboard.press('Delete');
  expect(await session(page)).toEqual({ active: true, warp: 'perspective' });
  await page.keyboard.press('Escape');
  expect(await layerCount(page)).toBe(2);
  expect(await historyLength(page)).toBe(n);
  expect(red(await pixel(page, 150, 150))).toBe(true);
  expect(errors).toEqual([]);
});

test('Warp and Puppet Warp keep the layer mask outside the warped box', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { background: 'transparent' });
  await paint(page, '#ff0000', [100, 100, 100, 100]);
  await runAwait(page, 'layer:mask', 'reveal-all');
  await page.evaluate(() => window.pigmentApp.setEditingMask(false));
  const maskAt = (x, y) => page.evaluate(([px, py]) => window.pigmentApp.doc.active.mask.canvas.getContext('2d').getImageData(px, py, 1, 1).data[3], [x, y]);
  const n = await historyLength(page);
  for (const kind of ['bezier', 'puppet']) {
    if (kind === 'bezier') {
      await runAwait(page, 'edit:transform-warp');
      await page.selectOption('#options-bar select[data-key="warp-preset"]', 'arch');
    } else {
      await runAwait(page, 'edit:puppet-warp');
      await click(page, 110, 150);
      await click(page, 190, 150);
      await drag(page, [190, 150], [190, 120]);
    }
    await expect.poll(() => page.evaluate(() => window.pigmentApp.transformTool.warp?.changed)).toBe(true);
    await focusCanvas(page);
    await page.keyboard.press('Enter');
    await expect.poll(() => session(page)).toEqual({ active: false, warp: null });
    expect(await maskAt(20, 20)).toBe(255);
    expect(await maskAt(350, 250)).toBe(255);
    expect(await maskAt(150, 150)).toBe(255);
    while ((await historyLength(page)) > n) await runAwait(page, 'edit:undo');
    expect(await maskAt(20, 20)).toBe(255);
  }
  // painting outside the old box still shows (the mask did not hide it)
  await paint(page, '#0000ff', [300, 30, 20, 20]);
  expect(await pixel(page, 310, 40)).toEqual([0, 0, 255, 255]);
  expect(errors).toEqual([]);
});

test('Warp toggles inside one session when untouched; a scaled Free Transform is applied first and survives any preset', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { background: 'transparent' });
  await paint(page, '#ff0000', [100, 100, 100, 100]);
  const n = await historyLength(page);
  // untouched: Warp, then the pressed button goes back to Free Transform without a history entry
  await runAwait(page, 'edit:free-transform');
  await page.locator('#options-bar .warp-toggle').click();
  await expect.poll(() => session(page)).toEqual({ active: true, warp: 'bezier' });
  await page.locator('#options-bar .warp-toggle').click();
  await expect.poll(() => session(page)).toEqual({ active: true, warp: null });
  expect(await historyLength(page)).toBe(n);
  // scale 2x, then Warp: the scale is applied as its own step and the warp starts on the scaled pixels
  await page.evaluate(() => {
    const tt = window.pigmentApp.transformTool;
    tt.session.quad = [[100, 100], [300, 100], [300, 300], [100, 300]];
    tt.update({ final: true });
  });
  await page.locator('#options-bar .warp-toggle').click();
  await expect.poll(() => session(page)).toEqual({ active: true, warp: 'bezier' });
  expect(await historyLength(page)).toBe(n + 1);
  expect(await page.evaluate(() => window.pigmentApp.transformTool.warp.box)).toEqual({ x: 100, y: 100, width: 200, height: 200 });
  expect(await page.evaluate(() => !!window.pigmentApp.transformTool.lastMatrix)).toBe(true);
  // a preset or None never loses the scale
  await page.selectOption('#options-bar select[data-key="warp-preset"]', 'arc');
  expect(red(await pixel(page, 250, 250))).toBe(true);
  await page.selectOption('#options-bar select[data-key="warp-preset"]', 'none');
  expect(red(await pixel(page, 250, 250))).toBe(true);
  // Escape cancels the warp only
  await focusCanvas(page);
  await page.keyboard.press('Escape');
  await expect.poll(() => session(page)).toEqual({ active: false, warp: null });
  expect(await historyLength(page)).toBe(n + 1);
  expect(red(await pixel(page, 250, 250))).toBe(true);
  expect(errors).toEqual([]);
});

test('Puppet Warp: a pin added after rotating the image lands on the pixel under the cursor and changes nothing', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { background: 'transparent' });
  await paint(page, '#ff0000', [100, 120, 200, 60]);
  await runAwait(page, 'edit:puppet-warp');
  await click(page, 110, 150);
  await click(page, 250, 150);
  // rotate around the second pin by about 60 degrees
  await page.evaluate(() => {
    const w = window.pigmentApp.transformTool.warp;
    w.pins[1].angle = Math.PI / 3;
    w.updateChanged();
    w.finish();
  });
  const before = await page.evaluate(() => {
    const w = window.pigmentApp.transformTool.warp;
    const out = [0, 0];
    return w.changed;
  });
  expect(before).toBe(true);
  const r = await page.evaluate(async () => {
    const w = window.pigmentApp.transformTool.warp;
    const { mlsPoint } = await import('/shared/pixels/warp.js');
    const target = [270, 175];
    const [fx, fy] = w.inverse(...target);
    const out = [0, 0];
    mlsPoint(w.mlsPins(), [fx, fy], { kind: w.kind_, alpha: 1 }, out);
    return { err: Math.hypot(out[0] - target[0], out[1] - target[1]) };
  });
  expect(r.err).toBeLessThan(0.5);
  await page.keyboard.press('Escape');
  expect(errors).toEqual([]);
});

test('Warp: H and V are idle for None and Custom, and None is always the identity', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { background: 'transparent' });
  await paint(page, '#ff0000', [100, 100, 200, 100]);
  const n = await historyLength(page);
  await runAwait(page, 'edit:transform-warp');
  await page.selectOption('#options-bar select[data-key="warp-preset"]', 'arc');
  await page.evaluate(() => window.pigmentApp.transformTool.warp.setPreset('arc', { h: 40 }));
  await expect(page.locator('#options-bar input[type="number"][data-key="warp-h"]')).toBeEnabled();
  await page.selectOption('#options-bar select[data-key="warp-preset"]', 'none');
  await expect(page.locator('#options-bar input[type="number"][data-key="warp-h"]')).toBeDisabled();
  await expect(page.locator('#options-bar input[type="number"][data-key="warp-v"]')).toBeDisabled();
  expect(await page.evaluate(() => ({ h: window.pigmentApp.transformTool.warp.h, changed: window.pigmentApp.transformTool.warp.changed }))).toEqual({ h: 0, changed: false });
  await focusCanvas(page);
  await page.keyboard.press('Enter');
  await expect.poll(() => session(page)).toEqual({ active: false, warp: null });
  expect(await historyLength(page)).toBe(n);
  expect(errors).toEqual([]);
});

test('Perspective Warp: Delete removes the quad of the selected corner; a collapsing merge is refused', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { background: 'transparent' });
  await paint(page, '#ff0000', [100, 100, 200, 100]);
  await runAwait(page, 'edit:perspective-warp');
  await drag(page, [100, 100], [180, 180]);
  await drag(page, [230, 100], [300, 180]);
  await expect.poll(() => page.evaluate(() => window.pigmentApp.transformTool.warp.quads.length)).toBe(2);
  // select a corner of the first quad, then Delete
  await page.evaluate(() => {
    const w = window.pigmentApp.transformTool.warp;
    w.selected = w.quads[0].pts[0];
  });
  await page.keyboard.press('Delete');
  const left = await page.evaluate(() => {
    const w = window.pigmentApp.transformTool.warp;
    return w.quads.map((q) => q.pts.map((i) => w.points[i].map(Math.round)));
  });
  expect(left).toHaveLength(1);
  expect(left[0][0]).toEqual([230, 100]);
  // dragging a corner onto its own neighbour would collapse the quad: the corner goes back
  await drag(page, [230, 100], [300, 100]);
  const q = await page.evaluate(() => {
    const w = window.pigmentApp.transformTool.warp;
    return { distinct: new Set(w.quads[0].pts).size, tl: w.points[w.quads[0].pts[0]].map(Math.round) };
  });
  expect(q).toEqual({ distinct: 4, tl: [230, 100] });
  await page.keyboard.press('Escape');
  expect(errors).toEqual([]);
});

test('Warp on a text layer: confirming the prompt rasterizes it and starts the warp', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { background: 'transparent' });
  await page.evaluate(async () => {
    const { TextLayer } = await import('/lib/document.js');
    const d = window.pigmentApp.doc;
    const l = new TextLayer({ name: 'Hello', text: 'Hello', x: 50, y: 50, font: { family: 'Arial', size: 36, color: '#0000ff' } });
    d.add(l, d.root, d.root.children.length);
    d.setActive(l);
    d.changed('tree');
  });
  await run(page, 'edit:transform-warp');
  const dialog = page.locator('.dialog-backdrop');
  await expect(dialog).toContainText(/Rasterize the text layer "Hello"/);
  await dialog.locator('.dialog-buttons .btn.primary').click();
  await expect.poll(() => session(page)).toEqual({ active: true, warp: 'bezier' });
  expect(await page.evaluate(() => window.pigmentApp.doc.active.type)).toBe('raster');
  expect((await labels(page)).at(-1)).toBe('Rasterize layer');
  await focusCanvas(page);
  await page.keyboard.press('Escape');
  expect(errors).toEqual([]);
});

test('Perspective Warp: a collapsed quad is left as it is, never erased', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { background: 'transparent' });
  await paint(page, '#ff0000', [50, 50, 300, 200]);
  await runAwait(page, 'edit:perspective-warp');
  await page.evaluate(() => {
    const w = window.pigmentApp.transformTool.warp;
    w.addQuad([[60, 60], [150, 60], [150, 200], [60, 200]]);
    w.addQuad([[250, 60], [340, 60], [340, 200], [250, 200]]);
    w.setMode('warp');
    // collapse quad 0 (its top-right corner onto its bottom-right one) and move quad 1 a little
    const q0 = w.quads[0].pts, q1 = w.quads[1].pts;
    w.points[q0[1]] = w.points[q0[2]].slice();
    w.points[q1[0]] = [w.points[q1[0]][0] - 10, w.points[q1[0]][1]];
    w.updateChanged();
    w.finish();
  });
  expect(await page.evaluate(() => window.pigmentApp.transformTool.warp.quads.map((q) => window.pigmentApp.transformTool.warp.validQuad(q)))).toEqual([false, true]);
  await page.keyboard.press('Enter');
  await expect.poll(() => session(page)).toEqual({ active: false, warp: null });
  expect(red(await pixel(page, 100, 150))).toBe(true);
  expect(red(await pixel(page, 70, 190))).toBe(true);
  expect(errors).toEqual([]);
});

test('Perspective Warp accepts a narrow quad', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { background: 'transparent' });
  await paint(page, '#ff0000', [50, 50, 300, 200]);
  await runAwait(page, 'edit:perspective-warp');
  const ok = await page.evaluate(() => {
    const w = window.pigmentApp.transformTool.warp;
    const zoom = window.pigmentApp.view.zoom;
    const narrow = 12 / zoom; // 12 screen px wide
    return w.addQuad([[100, 80], [100 + narrow, 80], [100 + narrow, 200], [100, 200]]);
  });
  expect(ok).toBe(true);
  await page.keyboard.press('Escape');
  expect(errors).toEqual([]);
});

test('Warp with a raster and a text layer selected shows the rasterize toast instead of dropping a layer', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { background: 'transparent' });
  await paint(page, '#ff0000', [100, 100, 100, 100]);
  await page.evaluate(async () => {
    const { TextLayer } = await import('/lib/document.js');
    const d = window.pigmentApp.doc;
    const raster = d.active;
    const l = new TextLayer({ name: 'Hello', text: 'Hello', x: 50, y: 50, font: { family: 'Arial', size: 36, color: '#0000ff' } });
    d.add(l, d.root, d.root.children.length);
    d.setActive(l);
    d.selected = new Set([raster, l]);
    d.changed('tree');
  });
  await runAwait(page, 'edit:transform-warp');
  await expect(page.locator('.toast.error')).toContainText(/Rasterize the text layer first/);
  expect(await page.locator('.dialog-backdrop').count()).toBe(0);
  expect(await session(page)).toEqual({ active: false, warp: null });
  expect(errors).toEqual([]);
});
