// Select > Subject, Sky, Focus Area…, Select and Mask… and the Object Selection tool
// (lib/select-mask.js, lib/select-mask/*.js, lib/tools/object-select.js): the selections land where
// the picture says, every result is one undoable history entry, the workspace takes over the
// window while it is open and leaves no trace when cancelled, and the pixel work runs in the worker.
import { test, expect } from '@playwright/test';
import { openApp, newDoc, run, runAwait, drag, screenPoint, historyLength } from './helpers.mjs';

/** Runs a painter over the active layer's 2D context (no history entry). */
const paint = (page, painter, arg) =>
  page.evaluate(([src, a]) => {
    const app = window.pigmentApp, l = app.doc.active, c = l.canvas;
    new Function('ctx', 'w', 'h', 'arg', src)(c.getContext('2d'), c.width, c.height, a);
    l.touch();
    app.doc.changed('pixels');
  }, [painter, arg]);

/** White page with a red disc (centre 200,150 radius 70) and a green square (300..360, 30..90). */
const DISC = `ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#d02020'; ctx.beginPath(); ctx.arc(200, 150, 70, 0, Math.PI * 2); ctx.fill();
  if (arg && arg.square) { ctx.fillStyle = '#208030'; ctx.fillRect(300, 30, 60, 60); }`;
/** Blue sky gradient over the top half, noisy brown ground below. */
const LANDSCAPE = `const g = ctx.createLinearGradient(0, 0, 0, h / 2); g.addColorStop(0, '#3f7fe0'); g.addColorStop(1, '#a8cdf5');
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h / 2);
  const img = ctx.getImageData(0, h / 2, w, h / 2); let s = 7;
  for (let i = 0; i < img.data.length; i += 4) { s = (s * 1664525 + 1013904223) >>> 0; const n = (s >>> 24) / 255;
    img.data[i] = 70 + n * 70; img.data[i + 1] = 50 + n * 50; img.data[i + 2] = 20 + n * 30; img.data[i + 3] = 255; }
  ctx.putImageData(img, 0, h / 2);`;
/** Fine black / white noise, sharp on the left half and blurred on the right half. */
const HALF_BLURRED = `const img = ctx.createImageData(w, h); let s = 3;
  for (let i = 0; i < img.data.length; i += 4) { s = (s * 1664525 + 1013904223) >>> 0; const v = (s >>> 24) > 127 ? 235 : 20;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v; img.data[i + 3] = 255; }
  ctx.putImageData(img, 0, 0);
  const t = document.createElement('canvas'); t.width = w; t.height = h; const tc = t.getContext('2d');
  tc.filter = 'blur(6px)'; tc.drawImage(ctx.canvas, 0, 0);
  ctx.drawImage(t, w / 2, 0, w / 2, h, w / 2, 0, w / 2, h);`;
/** Grey page with a red disc whose edge fades over 16 px (radius 62..78). */
const SOFT_DISC = `ctx.fillStyle = '#808080'; ctx.fillRect(0, 0, w, h);
  const g = ctx.createRadialGradient(200, 150, 62, 200, 150, 78); g.addColorStop(0, '#e01010'); g.addColorStop(1, 'rgba(224,16,16,0)');
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(200, 150, 80, 0, Math.PI * 2); ctx.fill();`;

const selection = (page) =>
  page.evaluate(() => {
    const s = window.pigmentApp.doc.selection;
    if (!s || s.isEmpty) return null;
    let selected = 0, soft = 0;
    for (const v of s.mask) {
      if (v >= 128) selected++;
      if (v > 0 && v < 255) soft++;
    }
    return { bounds: s.bounds, selected, soft };
  });
/** Selection coverage (0..255) at document points. */
const selAt = (page, points) => page.evaluate((pts) => pts.map(([x, y]) => window.pigmentApp.doc.selection?.mask[y * window.pigmentApp.doc.width + x] ?? 0), points);
const labels = (page) => page.evaluate(() => window.pigmentApp.doc.history.entries.slice(0, window.pigmentApp.doc.history.index + 1).map((e) => e.label));
const ws = (page) => page.evaluate(() => window.pigmentApp.selectMask.stats());
const wsMaskAt = (page, points) => page.evaluate((pts) => { const m = window.pigmentApp.selectMask.mask(), w = window.pigmentApp.doc.width; return pts.map(([x, y]) => m[y * w + x]); }, points);
const idle = (page) => page.evaluate(() => window.pigmentApp.selectMask.whenIdle());
const within = (a, b, tol) => Math.abs(a - b) <= tol;
const boundsNear = (b, e, tol = 3) => !!b && within(b.x, e.x, tol) && within(b.y, e.y, tol) && within(b.width, e.width, tol * 2) && within(b.height, e.height, tol * 2);

const openWorkspace = async (page) => {
  await run(page, 'select:select-mask');
  await expect(page.locator('.sm-panel')).toBeVisible();
};
const setField = async (page, key, value) => {
  const input = page.locator(`.sm-panel input[type="number"][data-key="${key}"]`);
  await input.fill(String(value));
  await input.press('Enter');
};
/** RGBA the view shows at a document point (device pixels of the view canvas). */
const viewPixel = (page, x, y) =>
  page.evaluate(async ([px, py]) => {
    const v = window.pigmentApp.view;
    v.invalidate();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const p = v.toScreen(px + 0.5, py + 0.5);
    return Array.from(v.ctx.getImageData(Math.round(p.x * v.dpr), Math.round(p.y * v.dpr), 1, 1).data);
  }, [x, y]);

test('Select Subject selects the red circle, in the worker, as one entry that undo clears', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  await paint(page, DISC);
  const h0 = await historyLength(page);
  expect(await runAwait(page, 'select:subject')).toBe(true);
  const s = await selection(page);
  expect(boundsNear(s.bounds, { x: 130, y: 80, width: 140, height: 140 })).toBe(true);
  // the area of the disc, within 2 %
  expect(Math.abs(s.selected - Math.PI * 70 * 70) / (Math.PI * 70 * 70)).toBeLessThan(0.02);
  expect(await selAt(page, [[200, 150], [200, 85], [20, 20], [280, 150]])).toEqual([255, 255, 0, 0]);
  expect(await labels(page)).toEqual(['Select Subject']);
  expect(await historyLength(page)).toBe(h0 + 1);
  // the cut ran off the main thread and reported its time
  const engine = await page.evaluate(() => ({ mode: window.pigmentApp.selectMask.engine.mode, ms: window.pigmentApp.selectMask.timings.subject }));
  expect(engine.mode).toBe('worker');
  expect(engine.ms).toBeGreaterThan(0);
  await runAwait(page, 'edit:undo');
  expect(await selection(page)).toBe(null);
  await runAwait(page, 'edit:redo');
  expect(boundsNear((await selection(page)).bounds, { x: 130, y: 80, width: 140, height: 140 })).toBe(true);
  // a layer in which nothing stands out: a hint, no selection, no entry
  await runAwait(page, 'select:none');
  await paint(page, `ctx.fillStyle = '#777777'; ctx.fillRect(0, 0, w, h);`);
  const h1 = await historyLength(page);
  expect(await runAwait(page, 'select:subject')).toBe(false);
  await expect(page.locator('.toast')).toContainText('No subject');
  expect(await selection(page)).toBe(null);
  expect(await historyLength(page)).toBe(h1);
  expect(errors).toEqual([]);
});

test('Select Sky takes the blue top half, not the ground; a picture without sky selects nothing', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  await paint(page, LANDSCAPE);
  expect(await runAwait(page, 'select:sky')).toBe(true);
  const s = await selection(page);
  expect(boundsNear(s.bounds, { x: 0, y: 0, width: 400, height: 150 }, 4)).toBe(true);
  expect(Math.abs(s.selected - 400 * 150) / (400 * 150)).toBeLessThan(0.04);
  expect(await selAt(page, [[200, 40], [10, 100], [200, 220], [390, 290]])).toEqual([255, 255, 0, 0]);
  expect(await labels(page)).toEqual(['Select Sky']);
  await runAwait(page, 'edit:undo');
  expect(await selection(page)).toBe(null);
  // nothing blue or bright at the top: ground all over
  await paint(page, `${LANDSCAPE} ctx.drawImage(ctx.canvas, 0, h / 2, w, h / 2, 0, 0, w, h / 2);`);
  expect(await runAwait(page, 'select:sky')).toBe(false);
  await expect(page.locator('.toast')).toContainText('No sky');
  expect(await selection(page)).toBe(null);
  expect(errors).toEqual([]);
});

test('Focus Area: the dialog finds the sharp half, Auto shows its range, OK outputs once and names the replay argument', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  await paint(page, HALF_BLURRED);
  const h0 = await historyLength(page);
  await page.evaluate(() => {
    window.__done = [];
    window.pigmentApp.on('command:done', (e) => window.__done.push({ id: e.id, arg: e.arg, cancelled: e.cancelled, replayable: e.replayable }));
  });
  await run(page, 'select:focus-area');
  const dialog = page.locator('.dialog.focus-area-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.focus-area-info')).toContainText('In-focus area found');
  // Auto picked a range and shows it
  await expect(dialog.locator('input[type="checkbox"][data-key="autoRange"]')).toBeChecked();
  const auto = Number(await dialog.locator('input[type="number"][data-key="range"]').inputValue());
  expect(auto).toBeGreaterThan(5);
  expect(auto).toBeLessThan(95);
  // the canvas behind the dialog previews the result: red overlay over the blurred half only
  const left = await viewPixel(page, 100, 150), right = await viewPixel(page, 300, 150);
  expect(Math.abs(left[0] - left[2])).toBeLessThan(25);
  expect(right[0] - right[2]).toBeGreaterThan(60);
  expect(await historyLength(page)).toBe(h0); // nothing recorded while the dialog is open
  // a manual range switches Auto off; 0 takes everything
  await dialog.locator('input[type="number"][data-key="range"]').fill('0');
  await expect(dialog.locator('input[type="checkbox"][data-key="autoRange"]')).not.toBeChecked();
  await expect.poll(async () => (await viewPixel(page, 300, 150))[0] - (await viewPixel(page, 300, 150))[2]).toBeLessThan(25);
  await dialog.locator('input[type="checkbox"][data-key="autoRange"]').check();
  await expect.poll(async () => Number(await dialog.locator('input[type="number"][data-key="range"]').inputValue())).toBe(auto);
  await dialog.locator('.dialog-buttons .btn.primary').click();
  await expect(page.locator('.dialog-backdrop')).toHaveCount(0);
  const s = await selection(page);
  expect(boundsNear(s.bounds, { x: 0, y: 0, width: 200, height: 300 }, 10)).toBe(true);
  expect(Math.abs(s.selected - 200 * 300) / (200 * 300)).toBeLessThan(0.08);
  expect(await selAt(page, [[60, 150], [340, 150]])).toEqual([255, 0]);
  expect(await labels(page)).toEqual(['Focus Area']);
  // the view is back to the plain image
  const after = await viewPixel(page, 300, 150);
  expect(Math.abs(after[0] - after[2])).toBeLessThan(25);
  // what an action would replay: the range that was used, no dialog
  const done = await page.evaluate(() => window.__done.find((e) => e.id === 'select:focus-area'));
  expect(done.cancelled).toBe(false);
  expect(done.replayable).toBe(true);
  expect(done.arg).toEqual({ range: auto, autoRange: false, noise: 'auto', soften: true, output: 'selection' });
  await runAwait(page, 'edit:undo');
  expect(await selection(page)).toBe(null);
  const bounds = s.bounds;
  await runAwait(page, 'select:focus-area', done.arg);
  await expect(page.locator('.dialog-backdrop')).toHaveCount(0);
  expect((await selection(page)).bounds).toEqual(bounds);
  // Output To: Layer Mask, through the argument
  await runAwait(page, 'select:none');
  const h1 = await historyLength(page);
  await runAwait(page, 'select:focus-area', { ...done.arg, output: 'mask' });
  expect(await historyLength(page)).toBe(h1 + 1);
  const mask = await page.evaluate(() => {
    const m = window.pigmentApp.doc.active.mask;
    const d = m.canvas.getContext('2d').getImageData(0, 150, 400, 1).data;
    return { enabled: m.enabled, left: d[60 * 4 + 3], right: d[340 * 4 + 3] };
  });
  expect(mask).toEqual({ enabled: true, left: 255, right: 0 });
  // Cancel leaves no trace
  const h2 = await historyLength(page);
  await run(page, 'select:focus-area');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.focus-area-info')).toContainText('In-focus area found');
  await page.keyboard.press('Escape');
  await expect(page.locator('.dialog-backdrop')).toHaveCount(0);
  expect(await historyLength(page)).toBe(h2);
  expect(await selection(page)).toBe(null);
  expect(errors).toEqual([]);
});

test('Select and Mask: the workspace takes over, Feather softens the selection, Output To Layer Mask is one entry', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  await paint(page, DISC);
  await runAwait(page, 'select:subject');
  const before = await selection(page);
  const h0 = await historyLength(page);
  await openWorkspace(page);
  // its own tool, tool strip and panel; the toolbox and the panel dock are away
  expect(await page.evaluate(() => window.pigmentApp.tools.active.id)).toBe('select-mask');
  await expect(page.locator('#panels')).toBeHidden();
  await expect(page.locator('#toolbox')).toBeHidden();
  await expect(page.locator('.sm-tools [data-tool]')).toHaveCount(8);
  await expect(page.locator('.sm-panel .sm-title')).toHaveText('Select and Mask');
  await expect(page.locator('.sm-panel select[data-key="view"] option')).toHaveCount(7);
  let s = await ws(page);
  expect(s.selected).toBe(before.selected);
  expect(s.engine).toBe('worker');
  const hard = s.soft;
  // Feather: many more partly selected pixels, about the same area
  await setField(page, 'feather', 10);
  await idle(page);
  s = await ws(page);
  expect(s.soft).toBeGreaterThan(hard + 3000);
  expect(Math.abs(s.selected - before.selected) / before.selected).toBeLessThan(0.03);
  expect(s.refines).toBeGreaterThan(0);
  await expect(page.locator('.sm-panel .sm-status')).toContainText('Edge refined in');
  const [mid, edge, out] = await wsMaskAt(page, [[200, 150], [270, 150], [290, 150]]);
  expect(mid).toBe(255);
  expect(edge).toBeGreaterThan(60);
  expect(edge).toBeLessThan(200);
  expect(out).toBeLessThan(10);
  // Contrast pulls the feathered edge back together
  await setField(page, 'contrast', 90);
  await idle(page);
  expect((await ws(page)).soft).toBeLessThan(s.soft / 2);
  await setField(page, 'contrast', 0);
  // Shift Edge moves it outwards
  await setField(page, 'shift', 80);
  await idle(page);
  expect((await ws(page)).selected).toBeGreaterThan(before.selected * 1.08);
  await setField(page, 'shift', 0);
  await idle(page);
  // nothing has touched the document so far
  expect(await historyLength(page)).toBe(h0);
  expect((await selection(page)).selected).toBe(before.selected);
  // Output To: Layer Mask, OK
  await page.locator('.sm-panel select[data-key="output"]').selectOption('mask');
  await page.locator('.sm-panel [data-action="ok"]').click();
  await expect(page.locator('.sm-panel')).toHaveCount(0);
  await expect(page.locator('#panels')).toBeVisible();
  await expect(page.locator('#toolbox')).toBeVisible();
  expect(await page.evaluate(() => window.pigmentApp.tools.active.id)).toBe('move');
  expect(await historyLength(page)).toBe(h0 + 1);
  expect((await labels(page)).at(-1)).toBe('Select and Mask');
  const mask = await page.evaluate(() => {
    const d = window.pigmentApp.doc, m = d.active.mask;
    const row = m.canvas.getContext('2d').getImageData(0, 150, 400, 1).data;
    return { enabled: m.enabled, mid: row[200 * 4 + 3], edge: row[270 * 4 + 3], out: row[300 * 4 + 3], selection: !!d.selection };
  });
  expect(mask.enabled).toBe(true);
  expect(mask.mid).toBe(255);
  expect(mask.edge).toBeGreaterThan(60);
  expect(mask.edge).toBeLessThan(200);
  expect(mask.out).toBe(0);
  expect(mask.selection).toBe(false); // the selection became the mask
  // the composite shows the disc through the feathered mask, nothing of the white page
  const px = await page.evaluate(() => Array.from(window.pigmentApp.doc.view.compositor.composite(window.pigmentApp.doc).getContext('2d').getImageData(20, 20, 1, 1).data));
  expect(px[3]).toBe(0);
  // one undo brings back the unmasked layer and the selection
  await runAwait(page, 'edit:undo');
  expect(await page.evaluate(() => window.pigmentApp.doc.active.mask)).toBe(null);
  expect((await selection(page)).selected).toBe(before.selected);
  expect(errors).toEqual([]);
});

test('Select and Mask: view modes, tools with their own undo, commands held back, Cancel leaves no trace', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  await paint(page, DISC, { square: true });
  const h0 = await historyLength(page);
  await openWorkspace(page);
  expect((await ws(page)).selected).toBe(0); // no selection to start from
  await expect(page.locator('.sm-panel .sm-status')).toContainText('Nothing is selected yet');

  // Brush: paint a stroke, Alt removes part of it, Ctrl+Z / Ctrl+Shift+Z step through the strokes
  await page.locator('.sm-tools [data-tool="brush"]').click();
  expect(await page.evaluate(() => window.pigmentApp.selectMask.tool)).toBe('brush');
  await page.evaluate(() => { window.pigmentApp.tools.setOpt('select-mask', 'brushSize', 30); window.pigmentApp.tools.setOpt('select-mask', 'brushHardness', 1); });
  await drag(page, [60, 240], [140, 240]);
  let s = await ws(page);
  expect(boundsNear(s.bounds, { x: 45, y: 225, width: 110, height: 30 }, 2)).toBe(true);
  const stroke = s.selected;
  expect(Math.abs(stroke - (80 * 30 + Math.PI * 15 * 15)) / stroke).toBeLessThan(0.04);
  await drag(page, [100, 220], [100, 260], { modifiers: ['Alt'] });
  s = await ws(page);
  expect(s.selected).toBeLessThan(stroke - 600);
  expect(await wsMaskAt(page, [[100, 240], [60, 240], [140, 240]])).toEqual([0, 255, 255]);
  expect(s.undo).toBe(2);
  await page.keyboard.press('Control+z');
  expect((await ws(page)).selected).toBe(stroke);
  await page.keyboard.press('Control+Shift+z');
  expect((await ws(page)).selected).toBe(s.selected);
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  expect((await ws(page)).selected).toBe(0);

  // Quick Selection: a stroke grows over the disc around the brush (three brush radii far) and stops at its edge
  await page.keyboard.press('w');
  expect(await page.evaluate(() => window.pigmentApp.selectMask.tool)).toBe('quick');
  await page.evaluate(() => window.pigmentApp.tools.setOpt('select-mask', 'quickSize', 40));
  await drag(page, [170, 150], [230, 150], { steps: 6 });
  s = await ws(page);
  expect(boundsNear(s.bounds, { x: 130, y: 90, width: 140, height: 120 }, 3)).toBe(true);
  await drag(page, [200, 120], [200, 180], { steps: 6 });
  s = await ws(page);
  expect(boundsNear(s.bounds, { x: 130, y: 80, width: 140, height: 140 }, 3)).toBe(true);
  expect(Math.abs(s.selected - Math.PI * 70 * 70) / (Math.PI * 70 * 70)).toBeLessThan(0.03);
  expect(await wsMaskAt(page, [[200, 150], [200, 84], [120, 150], [290, 150]])).toEqual([255, 255, 0, 0]);

  // Object Selection (W again): a rectangle around the square adds the square only
  await page.keyboard.press('w');
  expect(await page.evaluate(() => window.pigmentApp.selectMask.tool)).toBe('object');
  await drag(page, [285, 15], [375, 105]);
  await expect.poll(async () => (await ws(page)).undo).toBe(3);
  expect(await wsMaskAt(page, [[330, 60], [290, 20], [370, 100], [200, 150]])).toEqual([255, 0, 0, 255]);

  // Lasso with Alt: cut the right half of the square away again
  await page.keyboard.press('l');
  expect(await page.evaluate(() => window.pigmentApp.selectMask.tool)).toBe('lasso');
  const pts = [[330, 20], [380, 20], [380, 100], [330, 100]];
  const scr = [];
  for (const p of pts) scr.push(await screenPoint(page, ...p));
  await page.keyboard.down('Alt');
  await page.mouse.move(scr[0].x, scr[0].y);
  await page.mouse.down();
  for (const q of scr.slice(1)) await page.mouse.move(q.x, q.y, { steps: 4 });
  await page.mouse.up();
  await page.keyboard.up('Alt');
  expect(await wsMaskAt(page, [[315, 60], [345, 60]])).toEqual([255, 0]);

  // Polygonal Lasso: three clicks and Enter add a triangle (Enter closes the outline, it does not apply)
  await page.keyboard.press('l');
  expect(await page.evaluate(() => window.pigmentApp.selectMask.tool)).toBe('polygon');
  for (const p of [[40, 40], [100, 40], [40, 100]]) {
    const q = await screenPoint(page, ...p);
    await page.mouse.click(q.x, q.y);
  }
  await page.keyboard.press('Enter');
  await expect(page.locator('.sm-panel')).toBeVisible();
  expect(await wsMaskAt(page, [[55, 55], [95, 95]])).toEqual([255, 0]);

  // view modes change what the canvas shows, never the document
  const at = [330, 250]; // white page, not selected
  await page.locator('.sm-panel select[data-key="view"]').selectOption('black');
  expect((await viewPixel(page, ...at)).slice(0, 3)).toEqual([0, 0, 0]);
  expect((await viewPixel(page, 200, 150))[0]).toBeGreaterThan(190); // the selected disc stays red
  await page.keyboard.press('t'); // On White
  await expect(page.locator('.sm-panel select[data-key="view"]')).toHaveValue('white');
  expect((await viewPixel(page, ...at)).slice(0, 3)).toEqual([255, 255, 255]);
  await page.keyboard.press('k'); // Black & White: the mask itself
  expect((await viewPixel(page, ...at)).slice(0, 3)).toEqual([0, 0, 0]);
  expect((await viewPixel(page, 200, 150)).slice(0, 3)).toEqual([255, 255, 255]);
  await page.keyboard.press('v'); // Overlay: red over the masked page
  const ov = await viewPixel(page, ...at);
  expect(ov[0]).toBeGreaterThan(240);
  expect(ov[1]).toBeLessThan(140);
  await page.keyboard.press('y'); // On Layers: the page is masked away, the checkerboard shows
  const onLayers = await viewPixel(page, ...at);
  expect(onLayers[0]).toBe(onLayers[1]);
  expect(onLayers[0]).toBeGreaterThan(195);
  await page.keyboard.press('m'); // Marching Ants: the plain image
  expect((await viewPixel(page, ...at)).slice(0, 3)).toEqual([255, 255, 255]);
  await page.keyboard.press('o'); // Onion Skin at 50 %: the page half way to the checkerboard
  await expect(page.locator('.sm-panel input[type="number"][data-key="onion"]')).toBeVisible();

  // Invert and Clear Selection are steps of the workspace too
  const sel = (await ws(page)).selected;
  await page.locator('.sm-panel [data-action="invert"]').click();
  expect((await ws(page)).selected).toBe(400 * 300 - sel);
  await page.locator('.sm-panel [data-action="clear"]').click();
  expect((await ws(page)).selected).toBe(0);
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  expect((await ws(page)).selected).toBe(sel);

  // other commands wait until the workspace is closed
  await runAwait(page, 'image:adjust-invert');
  await runAwait(page, 'tool:brush');
  await runAwait(page, 'layer:new', { name: 'x' });
  expect(await historyLength(page)).toBe(h0);
  expect(await page.evaluate(() => [window.pigmentApp.tools.active.id, window.pigmentApp.doc.layers().length])).toEqual(['select-mask', 1]);

  // Escape cancels: no entry, no selection, everything back in place
  await page.keyboard.press('Escape');
  await expect(page.locator('.sm-panel')).toHaveCount(0);
  await expect(page.locator('.sm-tools')).toHaveCount(0);
  await expect(page.locator('#panels')).toBeVisible();
  expect(await historyLength(page)).toBe(h0);
  expect(await selection(page)).toBe(null);
  expect(await page.evaluate(() => [window.pigmentApp.tools.active.id, typeof window.pigmentApp.view.postProcess, document.body.classList.contains('select-mask-active')])).not.toContain('select-mask');
  expect((await viewPixel(page, ...at)).slice(0, 3)).toEqual([255, 255, 255]);
  expect(errors).toEqual([]);
});

test('Select and Mask: Edge Detection and the Refine Edge Brush find a soft edge; decontaminated output to a new layer; replay', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  await paint(page, SOFT_DISC);
  // a hard selection through the middle of the soft edge
  await page.evaluate(async () => {
    const { Selection } = await import('/lib/selection.js');
    const app = window.pigmentApp;
    app.applySelection(Selection.fromEllipse(400, 300, { x: 130, y: 80, width: 140, height: 140 }, { antialias: false }), 'replace', 'Ellipse');
  });
  const h0 = await historyLength(page);
  await page.evaluate(() => {
    window.__done = [];
    window.pigmentApp.on('command:done', (e) => window.__done.push({ id: e.id, arg: e.arg, cancelled: e.cancelled }));
  });
  await openWorkspace(page);
  let s = await ws(page);
  expect(s.soft).toBe(0);
  // Radius 12: alpha follows the fade of the disc inside the band and nowhere else
  await setField(page, 'radius', 12);
  await idle(page);
  s = await ws(page);
  expect(s.soft).toBeGreaterThan(2500);
  const band = await wsMaskAt(page, [[200, 150], [263, 150], [270, 150], [277, 150], [300, 150]]);
  expect(band[0]).toBe(255);
  expect(band[1]).toBeGreaterThan(band[2]);
  expect(band[2]).toBeGreaterThan(band[3]);
  expect(band[2]).toBeGreaterThan(40);
  expect(band[2]).toBeLessThan(215);
  expect(band[4]).toBe(0);
  // Show Edge shows the band: the image inside it, black elsewhere
  await page.keyboard.press('j');
  await expect(page.locator('.sm-panel input[type="checkbox"][data-key="showEdge"]')).toBeChecked();
  await idle(page);
  await expect.poll(async () => (await viewPixel(page, 200, 150)).slice(0, 3)).toEqual([0, 0, 0]);
  expect((await viewPixel(page, 268, 150))[0]).toBeGreaterThan(100);
  await page.keyboard.press('j');
  // Refine Edge Brush instead of a radius: only the painted part of the edge turns soft
  await setField(page, 'radius', 0);
  await idle(page);
  expect((await ws(page)).soft).toBe(0);
  await page.locator('.sm-tools [data-tool="refine"]').click();
  await page.evaluate(() => window.pigmentApp.tools.setOpt('select-mask', 'refineSize', 36));
  await drag(page, [270, 120], [270, 180]);
  await idle(page);
  s = await ws(page);
  expect(s.soft).toBeGreaterThan(400);
  const brushed = await wsMaskAt(page, [[270, 150], [130, 150], [200, 80]]);
  expect(brushed[0]).toBeGreaterThan(40);
  expect(brushed[0]).toBeLessThan(215);
  expect(brushed[1] === 0 || brushed[1] === 255).toBe(true); // the left edge was not painted
  await page.keyboard.press('Control+z');
  await idle(page);
  expect((await ws(page)).soft).toBe(0);
  // back to the radius, Object Aware gives a result too, then output a decontaminated copy
  await setField(page, 'radius', 12);
  await page.locator('.sm-panel .seg-button[data-value="object"]').click();
  await idle(page);
  expect((await ws(page)).soft).toBeGreaterThan(2500);
  await page.locator('.sm-panel input[type="checkbox"][data-key="decontaminate"]').check();
  // a selection cannot carry colours: the output moves to a new layer with a mask
  await expect(page.locator('.sm-panel select[data-key="output"]')).toHaveValue('layer-mask');
  await page.keyboard.press('Enter');
  await expect(page.locator('.sm-panel')).toHaveCount(0);
  expect(await historyLength(page)).toBe(h0 + 1);
  const out = await page.evaluate(() => {
    const d = window.pigmentApp.doc, layers = d.layers();
    const top = d.active, row = top.canvas.getContext('2d').getImageData(0, 150 - top.y, top.canvas.width, 1).data;
    const m = top.mask.canvas.getContext('2d').getImageData(0, 150, 400, 1).data;
    const at = (x) => Array.from(row.slice((x - top.x) * 4, (x - top.x) * 4 + 3));
    return { names: layers.map((l) => l.name), visible: layers.map((l) => l.visible), mask: [m[200 * 4 + 3], m[270 * 4 + 3], m[300 * 4 + 3]], edge: at(274), inside: at(200) };
  });
  expect(out.names).toEqual(['Background', 'Background copy']);
  expect(out.visible).toEqual([false, true]); // the original is hidden so the cut-out shows
  expect(out.mask[0]).toBe(255);
  expect(out.mask[1]).toBeGreaterThan(40);
  expect(out.mask[1]).toBeLessThan(215);
  expect(out.mask[2]).toBe(0);
  // the grey that showed through the soft edge is gone: the edge pixel took the disc's red
  expect(out.inside[0]).toBeGreaterThan(215);
  expect(out.edge[0]).toBeGreaterThan(200);
  expect(out.edge[1]).toBeLessThan(60);
  // one undo: the copy is gone, the original visible again
  await runAwait(page, 'edit:undo');
  expect(await page.evaluate(() => window.pigmentApp.doc.layers().map((l) => [l.name, l.visible]))).toEqual([['Background', true]]);
  // the settings replay without the workspace (what an action runs)
  const done = await page.evaluate(() => window.__done.find((e) => e.id === 'select:select-mask'));
  expect(done.cancelled).toBe(false);
  expect(done.arg).toEqual({ mode: 'object', radius: 12, smartRadius: false, smooth: 0, feather: 0, contrast: 0, shift: 0, decontaminate: true, amount: 100, output: 'layer-mask' });
  await runAwait(page, 'select:select-mask', { ...done.arg, decontaminate: false, output: 'selection' });
  await expect(page.locator('.sm-panel')).toHaveCount(0);
  expect((await selection(page)).soft).toBeGreaterThan(2500);
  expect((await labels(page)).at(-1)).toBe('Select and Mask');
  // New Document: the selected pixels in a document of their own, this one unchanged
  const h1 = await historyLength(page);
  await runAwait(page, 'select:select-mask', { radius: 0, output: 'document' });
  const docs = await page.evaluate(() => {
    const app = window.pigmentApp, d = app.doc, l = d.active;
    const c = d.view.compositor.composite(d).getContext('2d');
    return { count: app.docs.docs.length, name: d.name, size: [d.width, d.height], layers: d.layers().length, mid: c.getImageData(200, 150, 1, 1).data[3], corner: c.getImageData(10, 10, 1, 1).data[3], layerSize: [l.canvas.width, l.canvas.height] };
  });
  expect(docs.count).toBe(2);
  expect(docs.size).toEqual([400, 300]);
  expect(docs.layers).toBe(1);
  expect(docs.mid).toBe(255);
  expect(docs.corner).toBe(0);
  expect(docs.layerSize[0]).toBeLessThan(180);
  await page.evaluate(() => window.pigmentApp.docs.close(window.pigmentApp.doc, { force: true }));
  expect(await historyLength(page)).toBe(h1);
  expect(errors).toEqual([]);
});

test('Object Selection tool: a drag selects the object only; Shift adds, Alt subtracts, lasso mode, undo', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  await paint(page, DISC, { square: true });
  await runAwait(page, 'tool:object-select');
  expect(await page.evaluate(() => [window.pigmentApp.tools.active.id, window.pigmentApp.tools.slots.find((s) => s.id === 'wand').tools])).toEqual(['object-select', ['quick-select', 'wand', 'object-select']]);
  await expect(page.locator('#options-bar .options-title')).toContainText('Object Selection Tool');
  const h0 = await historyLength(page);
  // a loose rectangle around the disc: the disc, not the rectangle and not the square next to it
  await drag(page, [110, 60], [290, 240]);
  await expect.poll(() => historyLength(page)).toBe(h0 + 1);
  let s = await selection(page);
  expect(boundsNear(s.bounds, { x: 130, y: 80, width: 140, height: 140 })).toBe(true);
  expect(Math.abs(s.selected - Math.PI * 70 * 70) / (Math.PI * 70 * 70)).toBeLessThan(0.02);
  expect(await selAt(page, [[200, 150], [115, 65], [285, 235], [330, 60]])).toEqual([255, 0, 0, 0]);
  expect((await labels(page)).at(-1)).toBe('Object selection');
  // Shift adds the square
  await drag(page, [285, 15], [375, 105], { modifiers: ['Shift'] });
  await expect.poll(() => historyLength(page)).toBe(h0 + 2);
  expect(await selAt(page, [[200, 150], [330, 60], [290, 20]])).toEqual([255, 255, 0]);
  s = await selection(page);
  expect(Math.abs(s.selected - (Math.PI * 70 * 70 + 3600)) / s.selected).toBeLessThan(0.02);
  // Alt with Object Subtract removes the object in the region, not the region
  await drag(page, [285, 15], [375, 105], { modifiers: ['Alt'] });
  await expect.poll(() => historyLength(page)).toBe(h0 + 3);
  expect(await selAt(page, [[200, 150], [330, 60]])).toEqual([255, 0]);
  // without Object Subtract the rectangle itself is cut out of the disc
  await page.locator('#options-bar label[data-key="objectSubtract"] input').uncheck();
  await drag(page, [200, 100], [300, 200], { modifiers: ['Alt'] });
  await expect.poll(() => historyLength(page)).toBe(h0 + 4);
  expect(await selAt(page, [[230, 150], [160, 150], [205, 105]])).toEqual([0, 255, 0]);
  await runAwait(page, 'edit:undo');
  expect(await selAt(page, [[230, 150], [160, 150]])).toEqual([255, 255]);
  // Lasso mode: a rough outline around the square replaces the selection with the square
  await page.locator('#options-bar label[data-key="mode"] .seg-button[data-value="lasso"]').click();
  const outline = [[290, 20], [370, 15], [378, 100], [300, 104], [284, 60]];
  const scr = [];
  for (const p of outline) scr.push(await screenPoint(page, ...p));
  await page.mouse.move(scr[0].x, scr[0].y);
  await page.mouse.down();
  for (const q of scr.slice(1)) await page.mouse.move(q.x, q.y, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => (await selection(page))?.bounds.x).toBeGreaterThan(290);
  s = await selection(page);
  expect(boundsNear(s.bounds, { x: 300, y: 30, width: 60, height: 60 })).toBe(true);
  expect(await selAt(page, [[330, 60], [200, 150]])).toEqual([255, 0]);
  // a click away deselects, like the marquee
  const q = await screenPoint(page, 40, 260);
  await page.mouse.click(q.x, q.y);
  expect(await selection(page)).toBe(null);
  expect(errors).toEqual([]);
});

test('Focus Area hands over to Select and Mask; the workspace starts from a layer mask and gives it back refined', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  await paint(page, HALF_BLURRED);
  const h0 = await historyLength(page);
  await run(page, 'select:focus-area');
  const dialog = page.locator('.dialog.focus-area-dialog');
  await expect(dialog.locator('.focus-area-info')).toContainText('In-focus area found');
  await dialog.locator('.dialog-buttons button', { hasText: 'Select and Mask' }).click();
  await expect(page.locator('.dialog-backdrop')).toHaveCount(0);
  await expect(page.locator('.sm-panel')).toBeVisible();
  // the workspace opens on the dialog's result; the document is still untouched
  let s = await ws(page);
  expect(Math.abs(s.selected - 200 * 300) / (200 * 300)).toBeLessThan(0.08);
  expect(await historyLength(page)).toBe(h0);
  expect(await selection(page)).toBe(null);
  await page.locator('.sm-panel select[data-key="output"]').selectOption('mask');
  await page.locator('#options-bar [data-action="ok"]').click();
  await expect(page.locator('.sm-panel')).toHaveCount(0);
  expect(await historyLength(page)).toBe(h0 + 1);
  expect(await page.evaluate(() => !!window.pigmentApp.doc.active.mask)).toBe(true);
  // opened again without a selection, the workspace refines that mask and outputs to it by default
  await openWorkspace(page);
  await expect(page.locator('.sm-panel select[data-key="output"]')).toHaveValue('mask');
  expect((await ws(page)).selected).toBe(s.selected);
  await setField(page, 'feather', 6);
  await idle(page);
  s = await ws(page);
  expect(s.soft).toBeGreaterThan(2000);
  // Reset: the mask and the settings the workspace opened with
  await page.locator('.sm-panel [data-action="reset"]').click();
  await idle(page);
  await expect(page.locator('.sm-panel input[type="number"][data-key="feather"]')).toHaveValue('0');
  expect((await ws(page)).soft).toBeLessThan(s.soft / 4);
  await setField(page, 'feather', 6);
  await page.locator('.sm-panel [data-action="ok"]').click();
  await expect(page.locator('.sm-panel')).toHaveCount(0);
  expect(await historyLength(page)).toBe(h0 + 2);
  const soft = await page.evaluate(() => {
    const d = window.pigmentApp.doc.active.mask.canvas.getContext('2d').getImageData(0, 150, 400, 1).data;
    let n = 0;
    for (let x = 0; x < 400; x++) if (d[x * 4 + 3] > 0 && d[x * 4 + 3] < 255) n++;
    return n;
  });
  expect(soft).toBeGreaterThan(8);
  await runAwait(page, 'edit:undo');
  await runAwait(page, 'edit:undo');
  expect(await page.evaluate(() => window.pigmentApp.doc.active.mask)).toBe(null);
  expect(errors).toEqual([]);
});

test('without workers the same steps run on the main thread and give the same selection', async ({ page }) => {
  // a browser that cannot start the module worker (the engine falls back to lib/select-mask/ops.js in the page)
  await page.addInitScript(() => {
    window.Worker = class {
      constructor() {
        throw new Error('workers are not available');
      }
    };
  });
  const errors = await openApp(page);
  await newDoc(page);
  await paint(page, DISC, { square: true });
  expect(await runAwait(page, 'select:subject')).toBe(true);
  expect(await page.evaluate(() => window.pigmentApp.selectMask.engine.mode)).toBe('local');
  const s = await selection(page);
  expect(await selAt(page, [[200, 150], [20, 20]])).toEqual([255, 0]);
  // the workspace refines on the main thread too; a dropdown hands the keys back, so Enter applies
  await openWorkspace(page);
  await setField(page, 'feather', 5);
  await idle(page);
  expect((await ws(page)).soft).toBeGreaterThan(s.soft + 1500);
  await expect(page.locator('.sm-panel .sm-status')).toContainText('(no worker)');
  await page.locator('.sm-panel select[data-key="output"]').selectOption('layer');
  await page.keyboard.press('Enter');
  await expect(page.locator('.sm-panel')).toHaveCount(0);
  // New Layer: the cut-out alone, trimmed to the selection, above the hidden original
  const out = await page.evaluate(() => {
    const d = window.pigmentApp.doc, l = d.active;
    return { names: d.layers().map((x) => x.name), visible: d.layers().map((x) => x.visible), mask: !!l.mask, size: [l.canvas.width, l.canvas.height], alpha: l.canvas.getContext('2d').getImageData(200 - l.x, 150 - l.y, 1, 1).data[3], selection: !!d.selection };
  });
  expect(out.names).toEqual(['Background', 'Background copy']);
  expect(out.visible).toEqual([false, true]);
  expect(out.mask).toBe(false);
  expect(out.size[0]).toBeLessThan(400);
  expect(out.size[1]).toBeLessThan(300);
  expect(out.alpha).toBe(255);
  expect((await labels(page)).at(-1)).toBe('Select and Mask');
  // the only complaint is the engine's note about running without a worker (a warning, not an error)
  expect(errors).toEqual([]);
});

test('the workspace closes without a trace when another document takes over; hidden panels stay hidden afterwards', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  await paint(page, DISC);
  await runAwait(page, 'tool:brush');
  await runAwait(page, 'window:toggle-panels'); // Tab: panels away
  await expect(page.locator('#panels')).toBeHidden();
  const h0 = await historyLength(page);
  await openWorkspace(page); // the workspace shows its own strip and panel all the same
  await expect(page.locator('.sm-tools')).toBeVisible();
  await page.locator('.sm-tools [data-tool="brush"]').click();
  await drag(page, [60, 240], [140, 240]);
  expect((await ws(page)).selected).toBeGreaterThan(1000);
  // Tab moves the focus inside the panel instead of hiding the workspace
  await page.locator('.sm-panel [data-action="reset"]').focus();
  await page.keyboard.press('Tab');
  await expect(page.locator('.sm-panel')).toBeVisible();
  expect(await page.evaluate(() => !!document.activeElement.closest('.sm-panel'))).toBe(true);
  // a new document arrives (a file opened by the system, a script): the workspace gives way
  const first = await page.evaluate(() => {
    const app = window.pigmentApp, id = app.doc.id;
    app.newDocument({ width: 200, height: 100, name: 'Other' });
    return id;
  });
  await expect(page.locator('.sm-panel')).toHaveCount(0);
  await expect(page.locator('.sm-tools')).toHaveCount(0);
  const state = await page.evaluate((id) => {
    const app = window.pigmentApp, d = app.docs.docs.find((x) => x.id === id);
    return { tool: app.tools.active.id, active: app.selectMask.active, body: document.body.classList.contains('select-mask-active'), history: d.history.index + 1, selection: !!d.selection, hook: d.view.postProcess === null || typeof d.view.postProcess === 'function', ants: !!d.view.hideAnts, panelsHidden: document.getElementById('app').classList.contains('panels-hidden') };
  }, first);
  expect(state).toEqual({ tool: 'brush', active: false, body: false, history: h0, selection: false, hook: true, ants: false, panelsHidden: true });
  expect(errors).toEqual([]);
});
