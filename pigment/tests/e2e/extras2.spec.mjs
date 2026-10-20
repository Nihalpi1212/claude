// Extras regressions (bug hunt 3): path operations never restyle the active shape, text on a path
// survives Image Size and Text on Path, vertical orientation is refused on a path, the path text
// follows the live alignment, closed paths hide overflowing text, the hidden editor does not wrap,
// and Proof Colors refreshes while a brush stroke is still in progress.
import { test, expect } from '@playwright/test';
import { openApp, newDoc, runAwait, historyLength, screenPoint } from './helpers.mjs';

/** A white circle shape layer (centre 200,150, radius 100) and a red text layer above it, text active. */
async function circleAndText(page, text = 'Hello around the circle') {
  return page.evaluate(async (t) => {
    const app = window.pigmentApp;
    const { TextLayer, ShapeLayer } = await import('/lib/document.js');
    const { ellipsePath } = await import('/lib/tools/vector.js');
    const { structural } = await import('/lib/layer-ops.js');
    const doc = app.doc;
    const shape = new ShapeLayer({ name: 'Circle', path: ellipsePath(100, 50, 200, 200), fill: { type: 'solid', color: '#ffffff' } });
    const layer = new TextLayer({ name: 'Txt', text: t, x: 20, y: 20, font: { family: 'Arial', size: 24, color: '#ff0000' } });
    structural(app, 'Add', () => {
      doc.add(shape);
      doc.setActive(shape);
      doc.add(layer);
      doc.setActive(layer);
    });
    return layer.id;
  }, text);
}

/** Mean distance of the red pixels from (cx, cy), and their count. */
const redRadius = (page, cx, cy) =>
  page.evaluate(([x0, y0]) => {
    const d = window.pigmentApp.doc;
    const c = d.view.compositor.composite(d);
    const data = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0, sum = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (!(data[i] > 150 && data[i + 1] < 100 && data[i + 2] < 100)) continue;
      const x = (i / 4) % c.width, y = Math.floor(i / 4 / c.width);
      n++;
      sum += Math.hypot(x - x0, y - y0);
    }
    return { n, r: n ? sum / n : 0 };
  }, [cx, cy]);

test('choosing a path operation never restyles the active shape nor records a step', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { background: 'transparent' });
  await page.evaluate(async () => {
    const app = window.pigmentApp;
    const { ShapeLayer } = await import('/lib/document.js');
    const { ellipsePath } = await import('/lib/tools/vector.js');
    const { structural, setLayerProps } = await import('/lib/layer-ops.js');
    const shape = new ShapeLayer({ name: 'Box', path: ellipsePath(50, 50, 200, 150), fill: { type: 'solid', color: '#0000ff' } });
    structural(app, 'Add', () => {
      app.doc.add(shape);
      app.doc.setActive(shape);
    });
    setLayerProps(app, shape, { stroke: { color: '#000000', width: 6, align: 'center', dash: [] } }, 'Stroke width');
    const t = app.tools;
    t.setOpt('shape-rect', 'mode', 'shape', { silent: true });
    t.setOpt('shape-rect', 'strokeOn', false, { silent: true });
    t.activate('shape-rect');
  });
  const n = await historyLength(page);
  const sel = page.locator('#options-bar select[data-key="pathOp"], #options-bar .opt[data-key="pathOp"] select').first();
  await sel.selectOption('subtract');
  await sel.selectOption('intersect');
  const stroke = await page.evaluate(() => window.pigmentApp.doc.active.stroke);
  expect(stroke).toMatchObject({ color: '#000000', width: 6 });
  expect(await historyLength(page)).toBe(n);
  expect(errors).toEqual([]);
});

test('Image Size keeps text on its scaled path', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 400, height: 300 });
  await circleAndText(page);
  await runAwait(page, 'text:on-path');
  const before = await redRadius(page, 200, 150);
  expect(Math.abs(before.r - 100)).toBeLessThan(12);
  await runAwait(page, 'image:size', { width: 200, height: 150, method: 'bilinear', scaleStyles: true });
  const after = await redRadius(page, 100, 75);
  expect(Math.abs(after.r - 50)).toBeLessThan(8);
  expect(after.n).toBeGreaterThan(before.n * 0.15);
  expect(errors).toEqual([]);
});

test('Text on Path drops a Free Transform matrix so the glyphs sit on the path', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 400, height: 300 });
  await circleAndText(page);
  await page.evaluate(async () => {
    const { setLayerProps } = await import('/lib/layer-ops.js');
    const app = window.pigmentApp;
    setLayerProps(app, app.doc.active, { transform: [0, 1, -1, 0, 164.5, -52.5] }, 'Rotate');
  });
  await runAwait(page, 'text:on-path');
  expect(await page.evaluate(() => window.pigmentApp.doc.active.transform)).toBeNull();
  const s = await redRadius(page, 200, 150);
  expect(Math.abs(s.r - 100)).toBeLessThan(12);
  // one undo brings the rotated free text back
  await runAwait(page, 'edit:undo');
  expect(await page.evaluate(() => window.pigmentApp.doc.active.transform)).toEqual([0, 1, -1, 0, 164.5, -52.5]);
  expect(errors).toEqual([]);
});

test('vertical orientation is refused for text on a path', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 400, height: 300 });
  await circleAndText(page);
  await runAwait(page, 'text:on-path');
  const n = await historyLength(page);
  const before = await redRadius(page, 200, 150);
  for (const o of ['vertical', 'vertical-stacked']) await runAwait(page, 'text:orientation', o);
  await expect(page.locator('.toast.error').first()).toContainText(/always horizontal/);
  expect(await page.evaluate(() => ({ o: window.pigmentApp.doc.active.font.orientation ?? 'horizontal', t: window.pigmentApp.doc.active.transform }))).toEqual({ o: 'horizontal', t: null });
  expect(await historyLength(page)).toBe(n);
  expect((await redRadius(page, 200, 150)).n).toBe(before.n);
  expect(errors).toEqual([]);
});

test('text on a path follows the live alignment, and a closed path hides what does not fit', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 400, height: 300 });
  await circleAndText(page, 'ABC');
  await runAwait(page, 'text:on-path');
  const firstGlyph = () => page.evaluate(() => {
    const g = window.pigmentApp.doc.active.layout().glyphs[0];
    return [Math.round(g.x), Math.round(g.y)];
  });
  const left = await firstGlyph();
  await page.evaluate(async () => {
    const { setLayerProps } = await import('/lib/layer-ops.js');
    const app = window.pigmentApp;
    setLayerProps(app, app.doc.active, { font: { ...app.doc.active.font, align: 'center' } }, 'Character');
  });
  const centred = await firstGlyph();
  expect(centred).not.toEqual(left);
  // a sentence longer than the circumference (about 628 px) does not overprint its own start
  await page.evaluate(async () => {
    const { setLayerProps } = await import('/lib/layer-ops.js');
    const app = window.pigmentApp;
    setLayerProps(app, app.doc.active, { text: 'The quick brown fox jumps over the lazy dog and keeps running around the circle far past its start', font: { ...app.doc.active.font, align: 'left' } }, 'Typing');
  });
  const r = await page.evaluate(() => {
    const glyphs = window.pigmentApp.doc.active.layout().glyphs.filter((g) => g.ch.trim());
    const visible = glyphs.filter((g) => !g.hidden);
    let overlaps = 0;
    for (let i = 0; i < visible.length; i++) for (let j = i + 2; j < visible.length; j++) if (Math.hypot(visible[i].x - visible[j].x, visible[i].y - visible[j].y) < 4) overlaps++;
    return { hidden: glyphs.length - visible.length, overlaps };
  });
  expect(r.hidden).toBeGreaterThan(0);
  expect(r.overlaps).toBe(0);
  expect(errors).toEqual([]);
});

test('the hidden editor of text on a path does not soft-wrap', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  await page.evaluate(async () => {
    const app = window.pigmentApp;
    const { ShapeLayer } = await import('/lib/document.js');
    const { ellipsePath } = await import('/lib/tools/vector.js');
    const { structural } = await import('/lib/layer-ops.js');
    const shape = new ShapeLayer({ name: 'Circle', path: ellipsePath(100, 50, 200, 200), fill: { type: 'solid', color: '#ffffff' } });
    structural(app, 'Add', () => {
      app.doc.add(shape);
      app.doc.setActive(shape);
    });
    app.setColors({ foreground: '#ff0000' });
    app.tools.activate('type-horizontal');
  });
  const top = await screenPoint(page, 200, 50);
  await page.mouse.move(top.x - 30, top.y - 30);
  await page.mouse.move(top.x, top.y);
  await page.mouse.click(top.x, top.y);
  await expect.poll(() => page.evaluate(() => !!window.pigmentApp.tools.active.session)).toBe(true);
  await page.keyboard.type('Hello path text on a circle');
  const ta = await page.evaluate(() => {
    const t = window.pigmentApp.tools.active.session.textarea;
    return { wrap: t.wrap, ws: t.style.whiteSpace };
  });
  expect(ta).toEqual({ wrap: 'off', ws: 'pre' });
  await page.keyboard.press('Home');
  await page.keyboard.press('End');
  expect(await page.evaluate(() => window.pigmentApp.tools.active.session.textarea.selectionStart)).toBe('Hello path text on a circle'.length);
  await page.keyboard.press('Escape');
  expect(errors).toEqual([]);
});

test('Proof Colors refreshes during a brush stroke (no doc.changed until the stroke ends)', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 200, height: 100 });
  await runAwait(page, 'view:proof');
  await expect.poll(() => page.evaluate(() => window.pigmentApp.settings.proofColors)).toBe(true);
  const shown = () => page.evaluate(() => {
    const v = window.pigmentApp.view;
    v.paint();
    const p = v.toScreen(50, 50);
    return Array.from(v.ctx.getImageData(Math.round(p.x * v.dpr), Math.round(p.y * v.dpr), 1, 1).data).slice(0, 3);
  });
  const white = await shown();
  expect(white[0]).toBeGreaterThan(200);
  // what a stroke does mid-drag: pixels plus layer.touch() and an invalidate, no doc.changed
  await page.evaluate(() => {
    const l = window.pigmentApp.doc.active;
    const ctx = l.canvas.getContext('2d');
    ctx.fillStyle = '#000000';
    ctx.fillRect(40, 40, 20, 20);
    l.touch();
    window.pigmentApp.view.invalidate();
  });
  const painted = await shown();
  expect(painted[0]).toBeLessThan(80);
  await runAwait(page, 'view:proof');
  expect(errors).toEqual([]);
});
