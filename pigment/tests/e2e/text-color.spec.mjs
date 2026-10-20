// Text on a path, stacked vertical text (lib/text-path.js) and colour modes (lib/color-modes.js,
// Lab/CMYK readouts). See ARCHITECTURE.md "0.2 features".
import { test, expect } from '@playwright/test';
import { openApp, newDoc, run, runAwait, historyLength, screenPoint } from './helpers.mjs';

/** A white circle shape layer (centre 200,150, radius 100) and a red text layer above it, text active. */
async function circleAndText(page, text = 'Hello around the circle', extra = {}) {
  return page.evaluate(async ([t, x]) => {
    const app = window.pigmentApp;
    const { TextLayer, ShapeLayer } = await import('/lib/document.js');
    const { ellipsePath } = await import('/lib/tools/vector.js');
    const { structural } = await import('/lib/layer-ops.js');
    const doc = app.doc;
    const shape = new ShapeLayer({ name: 'Circle', path: ellipsePath(100, 50, 200, 200), fill: { type: 'solid', color: '#ffffff' } });
    const layer = new TextLayer({ name: 'Txt', text: t, x: 20, y: 20, font: { family: 'Arial', size: 24, color: '#ff0000', ...x } });
    structural(app, 'Add', () => {
      doc.add(shape);
      doc.setActive(shape);
      doc.add(layer);
      doc.setActive(layer);
    });
    return layer.id;
  }, [text, extra]);
}

/** Red pixels of the composite: count, mean distance from (cx, cy), bounding box. */
const redStats = (page, cx = 200, cy = 150) =>
  page.evaluate(([x0, y0]) => {
    const d = window.pigmentApp.doc;
    const c = d.view.compositor.composite(d);
    const data = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0, sum = 0, minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < data.length; i += 4) {
      if (!(data[i] > 150 && data[i + 1] < 100 && data[i + 2] < 100)) continue;
      const x = (i / 4) % c.width, y = Math.floor(i / 4 / c.width);
      n++;
      sum += Math.hypot(x - x0, y - y0);
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
    return { n, meanRadius: n ? sum / n : 0, width: n ? maxX - minX + 1 : 0, height: n ? maxY - minY + 1 : 0 };
  }, [cx, cy]);

const activeText = (page) => page.evaluate(() => {
  const l = window.pigmentApp.doc.active;
  return { text: l.text, orientation: l.font.orientation ?? 'horizontal', onPath: !!l.pathText, flip: !!l.pathText?.flip, x: l.x, y: l.y, transform: l.transform };
});

test('text on a circle path: glyphs at many angles along the circle, flip moves it to the other side, release keeps the text', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  await circleAndText(page);
  const plain = await redStats(page);
  expect(plain.n).toBeGreaterThan(100);
  expect(plain.height).toBeLessThan(40); // a straight line of text

  await runAwait(page, 'text:on-path');
  expect((await activeText(page)).onPath).toBe(true);
  const angles = await page.evaluate(() => new Set(window.pigmentApp.doc.active.layout().glyphs.map((g) => Math.round(g.angle * 10))).size);
  expect(angles).toBeGreaterThan(8);
  const onPath = await redStats(page);
  expect(onPath.n).toBeGreaterThan(100);
  expect(onPath.height).toBeGreaterThan(100); // wraps around the circle
  // the ink sits on the circle (radius 100) and the centre stays white
  expect(onPath.meanRadius).toBeGreaterThan(95);
  expect(onPath.meanRadius).toBeLessThan(130);
  expect(await page.evaluate(() => {
    const d = window.pigmentApp.doc;
    return Array.from(d.view.compositor.composite(d).getContext('2d').getImageData(200, 150, 1, 1).data);
  })).toEqual([255, 255, 255, 255]);

  await runAwait(page, 'text:flip-path');
  expect((await activeText(page)).flip).toBe(true);
  const flipped = await redStats(page);
  expect(flipped.n).toBeGreaterThan(100);
  expect(Math.abs(flipped.meanRadius - onPath.meanRadius)).toBeGreaterThan(10); // the other side of the path
  await runAwait(page, 'edit:undo');
  expect((await activeText(page)).flip).toBe(false);
  await runAwait(page, 'edit:redo');
  expect((await activeText(page)).flip).toBe(true);

  await runAwait(page, 'text:release-path');
  const released = await activeText(page);
  expect(released.onPath).toBe(false);
  expect(released.text).toBe('Hello around the circle');
  const after = await redStats(page);
  expect(after.n).toBeGreaterThan(100);
  expect(after.height).toBeLessThan(40);
  await runAwait(page, 'edit:undo');
  expect((await activeText(page)).onPath).toBe(true);
  expect(errors).toEqual([]);
});

test('the Type tool starts text on a path when clicking a shape path, and edits it in place', async ({ page }) => {
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
  // hovering the path shows the path cursor; clicking it starts a text layer on the path
  const top = await screenPoint(page, 200, 50);
  await page.mouse.move(top.x - 30, top.y - 30);
  await page.mouse.move(top.x, top.y);
  expect(await page.evaluate(() => window.pigmentApp.view.canvas.style.cursor)).toContain('url(');
  await page.mouse.click(top.x, top.y);
  await expect.poll(() => page.evaluate(() => !!window.pigmentApp.tools.active.session)).toBe(true);
  await page.keyboard.type('Curved');
  const live = await page.evaluate(() => {
    const l = window.pigmentApp.tools.active.session.layer;
    return { text: l.text, onPath: !!l.pathText, offset: l.pathText?.startOffset, glyphs: l.layout().glyphs.length };
  });
  expect(live).toEqual({ text: 'Curved', onPath: true, offset: expect.any(Number), glyphs: 6 });
  expect(live.offset).toBeLessThan(0.05); // the circle starts at its top, where we clicked
  await page.keyboard.press('Control+Enter');
  await expect.poll(() => page.evaluate(() => !!window.pigmentApp.tools.active.session)).toBe(false);
  const stats = await redStats(page);
  expect(stats.n).toBeGreaterThan(50);
  expect(stats.meanRadius).toBeGreaterThan(95);
  // clicking the text again opens it for editing with the caret near the clicked glyph
  const g = await page.evaluate(() => {
    const l = window.pigmentApp.doc.active;
    const gl = l.layout().glyphs[5];
    return { x: gl.x, y: gl.y - 8 };
  });
  const at = await screenPoint(page, g.x, g.y);
  await page.mouse.click(at.x, at.y);
  await expect.poll(() => page.evaluate(() => !!window.pigmentApp.tools.active.session)).toBe(true);
  expect(await page.evaluate(() => window.pigmentApp.tools.active.session.textarea.selectionStart)).toBeGreaterThanOrEqual(4);
  await page.keyboard.press('Escape');
  expect(errors).toEqual([]);
});

test('stacked vertical text is taller than wide, runs top to bottom and the orientation switch is undoable', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  await circleAndText(page, 'ABC');
  const horizontal = await redStats(page);
  expect(horizontal.width).toBeGreaterThan(horizontal.height);

  await runAwait(page, 'text:orientation', 'vertical-stacked');
  expect((await activeText(page)).orientation).toBe('vertical-stacked');
  const glyphs = await page.evaluate(() => window.pigmentApp.doc.active.layout().glyphs.map((g) => ({ ch: g.ch, x: Math.round(g.x), y: Math.round(g.y) })));
  expect(glyphs.map((g) => g.ch)).toEqual(['A', 'B', 'C']);
  expect(glyphs[0].y).toBeLessThan(glyphs[1].y);
  expect(glyphs[1].y).toBeLessThan(glyphs[2].y);
  expect(glyphs[0].x).toBe(glyphs[2].x);
  const stacked = await redStats(page);
  expect(stacked.height).toBeGreaterThan(stacked.width * 1.5);
  expect(stacked.n).toBeGreaterThan(50);
  // the ink of A is above the ink of C
  const rows = await page.evaluate(() => {
    const l = window.pigmentApp.doc.active;
    const r = l.render();
    const d = r.canvas.getContext('2d').getImageData(0, 0, r.canvas.width, r.canvas.height).data;
    let first = Infinity, last = -Infinity;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 100) {
      const y = Math.floor(i / 4 / r.canvas.width);
      first = Math.min(first, y);
      last = Math.max(last, y);
    }
    return { first, last, h: r.canvas.height };
  });
  expect(rows.last - rows.first).toBeGreaterThan(50);

  // the Character panel shows the orientation and switches it
  await runAwait(page, 'window:panel-character');
  await expect(page.locator('.char-panel [data-k="orientation"]')).toHaveValue('vertical-stacked');
  await page.locator('.char-panel [data-k="orientation"]').selectOption('vertical');
  await expect.poll(() => activeText(page).then((t) => t.orientation)).toBe('vertical');
  expect((await activeText(page)).transform).toEqual([0, 1, -1, 0, 40, 0]);
  await page.locator('.char-panel [data-k="orientation"]').selectOption('horizontal');
  await expect.poll(() => activeText(page).then((t) => t.orientation)).toBe('horizontal');
  expect((await activeText(page)).transform).toBeNull();

  const entries = await historyLength(page);
  await runAwait(page, 'edit:undo');
  expect((await activeText(page)).orientation).toBe('vertical');
  await runAwait(page, 'edit:undo');
  expect((await activeText(page)).orientation).toBe('vertical-stacked');
  await runAwait(page, 'edit:undo');
  expect((await activeText(page)).orientation).toBe('horizontal');
  expect(await redStats(page)).toEqual(horizontal);
  await runAwait(page, 'edit:redo');
  expect((await activeText(page)).orientation).toBe('vertical-stacked');
  expect(await historyLength(page)).toBe(entries - 2);
  expect(errors).toEqual([]);
});

test('text on a path and stacked text survive .pigment save/load and export rasterised to PSD', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  await circleAndText(page, 'Round');
  await runAwait(page, 'text:on-path');
  await circleAndText(page, 'Tall', { orientation: 'vertical-stacked' });
  const before = await page.evaluate(() => window.pigmentApp.doc.layers().filter((l) => l.type === 'text').map((l) => ({ text: l.text, onPath: !!l.pathText, orientation: l.font.orientation ?? 'horizontal', bounds: l.bounds() })));
  await page.evaluate(() => (window.__pigmentTest.nextSavePath = 'mem:/text.pigment'));
  await runAwait(page, 'file:save-as');
  await expect.poll(() => page.evaluate(() => !!window.__pigmentTest.written['mem:/text.pigment'])).toBe(true);
  await page.evaluate(() => (window.__pigmentTest.files['mem:/again.pigment'] = window.__pigmentTest.written['mem:/text.pigment']));
  await runAwait(page, 'file:open-paths', ['mem:/again.pigment']);
  await expect.poll(() => page.evaluate(() => window.pigmentApp.doc.path)).toBe('mem:/again.pigment');
  const after = await page.evaluate(() => window.pigmentApp.doc.layers().filter((l) => l.type === 'text').map((l) => ({ text: l.text, onPath: !!l.pathText, orientation: l.font.orientation ?? 'horizontal', bounds: l.bounds() })));
  expect(after).toEqual(before);
  expect(before.map((l) => [l.onPath, l.orientation])).toEqual([[true, 'horizontal'], [false, 'vertical-stacked']]);

  await page.evaluate(() => (window.__pigmentTest.nextSavePath = 'mem:/text.psd'));
  await runAwait(page, 'file:save-as');
  await expect.poll(() => page.evaluate(() => window.__pigmentTest.written['mem:/text.psd']?.length ?? 0)).toBeGreaterThan(1000);
  await page.evaluate(() => (window.__pigmentTest.files['mem:/again.psd'] = window.__pigmentTest.written['mem:/text.psd']));
  await runAwait(page, 'file:open-paths', ['mem:/again.psd']);
  await expect.poll(() => page.evaluate(() => window.pigmentApp.doc.path)).toBe('mem:/again.psd');
  // the PSD holds the glyphs as pixels (no text record that Photoshop would re-flow straight)
  const psd = await page.evaluate(() => window.pigmentApp.doc.layers().filter((l) => l.name === 'Txt').map((l) => l.type));
  expect(psd).toEqual(['raster', 'raster']);
  const stats = await redStats(page);
  expect(stats.n).toBeGreaterThan(100);
  expect(errors).toEqual([]);
});

test('Proof Colors changes a saturated green, Gamut Warning greys it, both restore when turned off', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 200, height: 100, background: 'color', backgroundColor: '#00ff00' });
  // the pixel the view draws at document (50, 50)
  const shown = () => page.evaluate(() => {
    const v = window.pigmentApp.view;
    v.paint();
    const p = v.toScreen(50, 50);
    return Array.from(v.ctx.getImageData(Math.round(p.x * v.dpr), Math.round(p.y * v.dpr), 1, 1).data).slice(0, 3);
  });
  expect(await shown()).toEqual([0, 255, 0]);
  await runAwait(page, 'view:proof');
  await expect.poll(() => page.evaluate(() => window.pigmentApp.settings.proofColors)).toBe(true);
  await expect.poll(() => page.evaluate(() => window.pigmentApp.uiState.proofColors)).toBe(true);
  const proofed = await shown();
  expect(proofed[1]).toBeLessThan(200);
  expect(proofed[1]).toBeGreaterThan(100);
  expect(proofed[0]).toBeLessThan(20);
  await runAwait(page, 'view:gamut');
  await expect.poll(() => page.evaluate(() => window.pigmentApp.uiState.gamutWarning)).toBe(true);
  expect(await shown()).toEqual([128, 128, 128]);
  await runAwait(page, 'view:proof');
  await expect.poll(() => page.evaluate(() => window.pigmentApp.settings.proofColors)).toBe(false);
  expect(await shown()).toEqual([128, 128, 128]); // the warning alone still greys
  await runAwait(page, 'view:gamut');
  await expect.poll(() => page.evaluate(() => window.pigmentApp.settings.gamutWarning)).toBe(false);
  expect(await shown()).toEqual([0, 255, 0]);
  // the document pixels never changed
  expect(await page.evaluate(() => Array.from(window.pigmentApp.doc.active.canvas.getContext('2d').getImageData(50, 50, 1, 1).data))).toEqual([0, 255, 0, 255]);
  expect(errors).toEqual([]);
});

test('the Info panel shows CMYK (and Lab) values for a known colour', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 200, height: 100, background: 'color', backgroundColor: '#ff0000' });
  await runAwait(page, 'window:panel-info');
  await page.evaluate(() => window.pigmentApp.emit('pointer:moved', { view: window.pigmentApp.view, x: 10, y: 10 }));
  const alt = page.locator('.info-panel .info-alt');
  await expect(alt).toHaveText(/C0%M100%Y100%K0%/);
  await expect(page.locator('.info-panel [data-k="r"]')).toHaveText('255');
  await page.locator('.info-panel .info-mode').selectOption('lab');
  await page.evaluate(() => window.pigmentApp.emit('pointer:moved', { view: window.pigmentApp.view, x: 12, y: 12 }));
  await expect(alt).toHaveText(/L53a80b67/);
  expect(await page.evaluate(() => window.pigmentApp.settings.infoSecondary)).toBe('lab');
  // the colour picker dialog carries the same readouts
  await page.evaluate(() => {
    window.__pickResult = window.pigmentApp.pickColor('#ff0000');
  });
  const dlg = page.locator('.color-picker-dialog');
  await expect(dlg.locator('[data-m="m"]')).toHaveValue('100');
  await expect(dlg.locator('[data-m="L"]')).toHaveValue('53');
  await dlg.locator('[data-m="c"]').fill('100');
  await dlg.locator('[data-m="c"]').blur(); // commits the field (Enter would also press the dialog's OK)
  await expect(dlg.locator('[data-m="L"]')).toHaveValue('0'); // C+M+Y = black
  await dlg.locator('.dialog-buttons .btn.primary').click();
  expect(await page.evaluate(() => window.__pickResult)).toBe('#000000');
  expect(errors).toEqual([]);
});
