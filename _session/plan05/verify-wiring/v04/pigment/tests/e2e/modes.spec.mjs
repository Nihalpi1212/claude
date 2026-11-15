// Image modes (builder "modes"): Image > Mode (all eight), Color Table, Trap, Conditional Mode Change,
// Save for Web, GIF / PNG-8 export, the GIF reader that keeps the colour table, the mode-aware Channels panel.
import { test, expect } from '@playwright/test';
import { openApp, newDoc, run, runAwait, pixel, layerPixel, confirmDialog, historyLength } from './helpers.mjs';
import { decodeGif, encodeGif } from '../../src/shared/pixels/gif.js';
import { decodePng, toRgba8 } from '../../src/shared/pixels/png.js';
import { writeAct, parseAct } from '../../src/shared/pixels/quantize.js';

const COMMANDS = ['image:mode', 'image:color-table', 'image:trap', 'file:automate-conditional-mode', 'file:save-for-web'];
const dialog = (page) => page.locator('.dialog-backdrop').last();
const expectNoDialog = (page) => expect(page.locator('.dialog-backdrop')).toHaveCount(0);
const mode = (page) => page.evaluate(() => window.pigmentApp.doc.mode);
const written = (page, path) => page.evaluate((p) => (window.__pigmentTest.written[p] ? Array.from(window.__pigmentTest.written[p]) : null), path);
const setNumber = async (page, key, value) => {
  const input = dialog(page).locator(`input[type="number"][data-key="${key}"]`);
  await input.fill(String(value));
  await input.dispatchEvent('change');
};

/** Paints rectangles [x, y, w, h, css] into the active layer (test setup, not an undo step). */
const paint = (page, rects) =>
  page.evaluate((list) => {
    const d = window.pigmentApp.doc, l = d.active;
    const ctx = l.canvas.getContext('2d');
    for (const [x, y, w, h, css] of list) {
      ctx.clearRect(x - l.x, y - l.y, w, h);
      ctx.fillStyle = css;
      ctx.fillRect(x - l.x, y - l.y, w, h);
    }
    l.touch();
    d.changed('pixels', { layer: l });
  }, rects);

/** Distinct opaque colours of the flattened document, as 'r,g,b' strings. */
const distinctColors = (page) =>
  page.evaluate(() => {
    const d = window.pigmentApp.doc;
    const data = d.view.compositor.composite(d).getContext('2d').getImageData(0, 0, d.width, d.height).data;
    const set = new Set();
    for (let i = 0; i < data.length; i += 4) if (data[i + 3]) set.add(`${data[i]},${data[i + 1]},${data[i + 2]}`);
    return [...set].sort();
  });

/** Four colour quadrants: red, green, blue, yellow. */
const quadrants = (page) => paint(page, [[0, 0, 200, 150, '#ff0000'], [200, 0, 200, 150, '#00ff00'], [0, 150, 200, 150, '#0000ff'], [200, 150, 200, 150, '#ffff00']]);

test('the mode commands are real: registered, enabled where they apply, not stubbed', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  const info = await page.evaluate((cmds) => {
    const app = window.pigmentApp;
    return { has: cmds.map((c) => app.commands.has(c)), stubbed: cmds.filter((c) => app.stubbed.includes(c)), enabled: cmds.map((c) => app.commands.isEnabled(c)), api: Object.keys(app.modes.MODES), constraint: [typeof app.colorConstraint, app.pixelConstraint] };
  }, COMMANDS);
  expect(info.has).toEqual([true, true, true, true, true]);
  expect(info.stubbed).toEqual([]);
  // Color Table needs an indexed document and Trap a CMYK one
  expect(info.enabled).toEqual([true, false, false, true, true]);
  expect(info.api).toEqual(['bitmap', 'grayscale', 'duotone', 'indexed', 'rgb', 'cmyk', 'lab', 'multichannel']);
  // the pixel constraint is only installed while the active document needs one
  expect(info.constraint).toEqual(['function', null]);
  expect(errors).toEqual([]);
});

test('Grayscale makes a red pixel grey, undo restores it, and layered documents are asked about flattening', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  await paint(page, [[0, 0, 200, 300, '#ff0000'], [200, 0, 200, 300, '#0000ff']]);
  expect(await runAwait(page, 'image:mode', 'grayscale')).toBe(true); // one plain layer: nothing to ask
  expect(await mode(page)).toBe('grayscale');
  expect(await pixel(page, 10, 10)).toEqual([76, 76, 76, 255]);
  expect(await layerPixel(page, 10, 10)).toEqual([76, 76, 76, 255]); // the pixels are grey, not just their display
  expect(await pixel(page, 300, 10)).toEqual([29, 29, 29, 255]);
  expect(await historyLength(page)).toBe(1);
  expect(await page.evaluate(() => [window.pigmentApp.uiState.mode, window.pigmentApp.doc.history.entries[0].label, typeof window.pigmentApp.pixelConstraint])).toEqual(['grayscale', 'Grayscale', 'function']);
  await runAwait(page, 'edit:undo');
  expect(await mode(page)).toBe('rgb');
  expect(await pixel(page, 10, 10)).toEqual([255, 0, 0, 255]);
  expect(await layerPixel(page, 10, 10)).toEqual([255, 0, 0, 255]);
  expect(await page.evaluate(() => window.pigmentApp.pixelConstraint)).toBe(null);
  await runAwait(page, 'edit:redo');
  expect(await mode(page)).toBe('grayscale');
  expect(await pixel(page, 10, 10)).toEqual([76, 76, 76, 255]);
  await runAwait(page, 'edit:undo');

  // two layers: Photoshop's question. "Don't Flatten" converts each layer and keeps them
  await runAwait(page, 'layer:new', { name: 'Top' });
  await paint(page, [[50, 50, 100, 100, '#00ff00']]);
  const before = await historyLength(page);
  await run(page, 'image:mode', 'grayscale');
  await expect(dialog(page)).toContainText('Flatten image before mode change?');
  await dialog(page).locator('.dialog-buttons .btn', { hasText: "Don't Flatten" }).click();
  await expect.poll(() => mode(page)).toBe('grayscale');
  expect(await page.evaluate(() => window.pigmentApp.doc.layers().length)).toBe(2);
  expect(await pixel(page, 60, 60)).toEqual([150, 150, 150, 255]);
  expect(await layerPixel(page, 60, 60)).toEqual([150, 150, 150, 255]);
  expect(await historyLength(page)).toBe(before + 1);
  await runAwait(page, 'edit:undo');
  expect(await layerPixel(page, 60, 60)).toEqual([0, 255, 0, 255]);
  // "Flatten" merges first; Cancel does nothing
  await run(page, 'image:mode', 'grayscale');
  await dialog(page).locator('.dialog-buttons .btn', { hasText: 'Cancel' }).click();
  await expectNoDialog(page);
  expect(await mode(page)).toBe('rgb');
  await run(page, 'image:mode', 'grayscale');
  await confirmDialog(page);
  await expect.poll(() => mode(page)).toBe('grayscale');
  expect(await page.evaluate(() => window.pigmentApp.doc.layers().map((l) => l.name))).toEqual(['Background']);
  expect(await pixel(page, 60, 60)).toEqual([150, 150, 150, 255]);
  expect(await historyLength(page)).toBe(before + 1);
  await runAwait(page, 'edit:undo');
  expect(await page.evaluate(() => window.pigmentApp.doc.layers().length)).toBe(2);
  expect(await pixel(page, 60, 60)).toEqual([0, 255, 0, 255]);

  // a grey document keeps edits grey: a strongly coloured adjustment still commits grey pixels
  await runAwait(page, 'image:mode', { mode: 'grayscale', flatten: true });
  await runAwait(page, 'image:adjust-photo-filter', { color: '#ff0000', density: 100, preserveLuminosity: false });
  const p = await layerPixel(page, 300, 200);
  expect(p[0] === p[1] && p[1] === p[2]).toBe(true);
  expect(errors).toEqual([]);
});

test('Indexed Color with 4 colours leaves 4 distinct colours and Color Table lists and edits them', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  // four flat colours plus a smooth ramp, so 4 colours is a real reduction
  await quadrants(page);
  await page.evaluate(() => {
    const d = window.pigmentApp.doc, l = d.active, ctx = l.canvas.getContext('2d');
    const g = ctx.createLinearGradient(100, 0, 300, 0);
    g.addColorStop(0, '#ff0000');
    g.addColorStop(1, '#00ff00');
    ctx.fillStyle = g;
    ctx.fillRect(100, 20, 200, 10);
    l.touch();
    d.changed('pixels', { layer: l });
  });
  expect((await distinctColors(page)).length).toBeGreaterThan(20);
  await run(page, 'image:mode', 'indexed');
  await expect(dialog(page)).toContainText('Indexed Color');
  await dialog(page).locator('select[data-key="palette"]').selectOption('adaptive');
  await setNumber(page, 'colors', 4);
  await dialog(page).locator('select[data-key="dither"]').selectOption('none');
  await expect(dialog(page).locator('.indexed-info')).toContainText('4 colors');
  await confirmDialog(page);
  await expect.poll(() => mode(page)).toBe('indexed');
  const colors = await distinctColors(page);
  expect(colors.length).toBe(4);
  const table = await page.evaluate(() => window.pigmentApp.doc.colorTable);
  expect(table.length).toBe(4);
  expect(table.map((c) => c.join(',')).sort()).toEqual(colors);
  expect(await historyLength(page)).toBe(1);
  expect(await page.evaluate(() => window.pigmentApp.commands.isEnabled('image:color-table'))).toBe(true);

  // Color Table lists the four entries
  await run(page, 'image:color-table');
  await expect(dialog(page).locator('.ct-cell.filled')).toHaveCount(4);
  const shown = await dialog(page).locator('.ct-cell.filled').evaluateAll((cells) => cells.map((c) => getComputedStyle(c).backgroundColor.match(/\d+/g).slice(0, 3).join(',')));
  expect(shown).toEqual(table.map((c) => c.join(',')));
  // a preset replaces the table; Cancel leaves the document alone
  await dialog(page).locator('select[data-key="ct-preset"]').selectOption('grayscale');
  await expect(dialog(page).locator('.ct-cell.filled')).toHaveCount(256);
  // Save writes an .act file that reads back as the table on screen
  await page.evaluate(() => (window.__pigmentTest.nextSavePath = 'browser:/tables/grey.act'));
  await dialog(page).locator('[data-act="save"]').click();
  await expect.poll(() => written(page, 'browser:/tables/grey.act')).not.toBeNull();
  const act = parseAct(Uint8Array.from(await written(page, 'browser:/tables/grey.act')));
  expect(act.palette.length).toBe(256);
  expect(act.palette[77]).toEqual([77, 77, 77]);
  await dialog(page).locator('.dialog-buttons .btn', { hasText: 'Cancel' }).click();
  await expectNoDialog(page);
  expect(await page.evaluate(() => window.pigmentApp.doc.colorTable.length)).toBe(4);

  // changing an entry recolours the pixels that use it (they keep their index); one undo step
  const red = table.findIndex((c) => c[0] > 200 && c[1] < 60 && c[2] < 60);
  expect(red).toBeGreaterThanOrEqual(0);
  const next = table.map((c, i) => (i === red ? [10, 200, 220] : c));
  expect(await pixel(page, 10, 100)).toEqual([...table[red], 255]);
  await runAwait(page, 'image:color-table', { table: next, transparentIndex: -1 });
  expect(await pixel(page, 10, 100)).toEqual([10, 200, 220, 255]);
  expect(await page.evaluate(() => window.pigmentApp.doc.colorTable)).toEqual(next);
  expect(await historyLength(page)).toBe(2);
  // making an entry transparent clears its pixels
  await runAwait(page, 'image:color-table', { table: next, transparentIndex: red });
  expect((await pixel(page, 10, 100))[3]).toBe(0);
  await runAwait(page, 'edit:undo');
  await runAwait(page, 'edit:undo');
  expect(await pixel(page, 10, 100)).toEqual([...table[red], 255]);
  expect(await page.evaluate(() => window.pigmentApp.doc.colorTable)).toEqual(table);

  // loading an .act file through the dialog and confirming applies it
  const loaded = [[1, 2, 3], [250, 0, 0], [0, 250, 0], [0, 0, 250]];
  await page.evaluate((bytes) => (window.__pigmentTest.files['browser:/tables/four.act'] = Uint8Array.from(bytes)), Array.from(writeAct(loaded)));
  await run(page, 'image:color-table');
  const chooser = page.waitForEvent('filechooser', { timeout: 3000 }).catch(() => null);
  await dialog(page).locator('[data-act="load"]').click();
  const fc = await chooser;
  if (fc) {
    await fc.setFiles({ name: 'four.act', mimeType: 'application/octet-stream', buffer: Buffer.from(writeAct(loaded)) });
    await expect(dialog(page).locator('.ct-cell.filled')).toHaveCount(4);
    await confirmDialog(page);
    await expect.poll(() => page.evaluate(() => window.pigmentApp.doc.colorTable)).toEqual(loaded);
  } else await dialog(page).locator('.dialog-buttons .btn', { hasText: 'Cancel' }).click();

  // picked colours snap to the table, and painting through a filter stays inside it
  await page.evaluate(() => window.pigmentApp.setColors({ foreground: '#f01008' }));
  const fg = await page.evaluate(() => window.pigmentApp.settings.foreground);
  const tableNow = await page.evaluate(() => window.pigmentApp.doc.colorTable.map((c) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('')));
  expect(tableNow).toContain(fg);
  await runAwait(page, 'filter:gaussian-blur', { radius: 6 });
  const after = await distinctColors(page);
  for (const c of after) expect(tableNow).toContain('#' + c.split(',').map((v) => Number(v).toString(16).padStart(2, '0')).join(''));

  // back to RGB: the pixels are what the table showed, free again
  await runAwait(page, 'image:mode', 'rgb');
  expect(await mode(page)).toBe('rgb');
  expect(await page.evaluate(() => window.pigmentApp.doc.colorTable)).toBe(null);
  expect(errors).toEqual([]);
});

test('Bitmap: 50% threshold through the dialog, flatten confirmation, dithers and the output resolution', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  // greys 100 and 160 on either side of the threshold, on two layers
  await paint(page, [[0, 0, 200, 300, 'rgb(100,100,100)']]);
  await runAwait(page, 'layer:new', { name: 'Right' });
  await paint(page, [[200, 0, 200, 300, 'rgb(160,160,160)']]);
  await run(page, 'image:mode', 'bitmap');
  // layers first: bitmap documents hold one layer
  await expect(dialog(page)).toContainText('Flatten layers?');
  await dialog(page).locator('.dialog-buttons .btn.primary').click(); // Flatten; the Bitmap dialog follows
  await expect(dialog(page).locator('select[data-key="method"]')).toBeVisible();
  await expect(dialog(page)).toContainText('Input: 72 pixels/inch');
  await dialog(page).locator('select[data-key="method"]').selectOption('50-threshold');
  // the canvas previews the result while the dialog is open; the document is untouched
  await expect.poll(() => page.evaluate(() => {
    const v = window.pigmentApp.view;
    const c = v.postProcess?.(v.compositor.composite(v.doc), v);
    return c ? Array.from(c.getContext('2d').getImageData(50, 50, 1, 1).data) : null;
  })).toEqual([0, 0, 0, 255]);
  expect(await mode(page)).toBe('rgb');
  expect(await pixel(page, 50, 50)).toEqual([100, 100, 100, 255]);
  await confirmDialog(page);
  await expect.poll(() => mode(page)).toBe('bitmap');
  expect(await pixel(page, 50, 50)).toEqual([0, 0, 0, 255]);
  expect(await pixel(page, 350, 50)).toEqual([255, 255, 255, 255]);
  expect(await page.evaluate(() => window.pigmentApp.doc.layers().length)).toBe(1);
  expect((await distinctColors(page)).sort()).toEqual(['0,0,0', '255,255,255']);
  expect(await historyLength(page)).toBe(2); // the new layer, then the conversion (flatten included) as one entry
  await runAwait(page, 'edit:undo');
  expect(await mode(page)).toBe('rgb');
  expect(await page.evaluate(() => window.pigmentApp.doc.layers().length)).toBe(2);
  expect(await pixel(page, 50, 50)).toEqual([100, 100, 100, 255]);

  // diffusion dither keeps the tone: about 100/255 of the left half is white
  await runAwait(page, 'image:mode', { mode: 'bitmap', flatten: true, options: { method: 'diffusion-dither' } });
  const share = await page.evaluate(() => {
    const d = window.pigmentApp.doc;
    const data = d.view.compositor.composite(d).getContext('2d').getImageData(0, 0, 200, 300).data;
    let white = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i] === 255) white++;
    return white / (200 * 300);
  });
  expect(Math.abs(share - 100 / 255)).toBeLessThan(0.02);
  // a bitmap document paints black or white only
  await page.evaluate(() => window.pigmentApp.setColors({ foreground: '#ff0000', background: '#00ff00' }));
  expect(await page.evaluate(() => [window.pigmentApp.settings.foreground, window.pigmentApp.settings.background])).toEqual(['#000000', '#ffffff']);
  await runAwait(page, 'edit:undo');

  // output resolution: 144 ppi doubles the pixel size and keeps the print size
  await runAwait(page, 'image:mode', { mode: 'bitmap', flatten: true, options: { method: 'halftone-screen', dpi: 144, frequency: 18, angle: 45, shape: 'round' } });
  expect(await page.evaluate(() => [window.pigmentApp.doc.width, window.pigmentApp.doc.height, window.pigmentApp.doc.dpi])).toEqual([800, 600, 144]);
  expect((await distinctColors(page)).sort()).toEqual(['0,0,0', '255,255,255']);
  await runAwait(page, 'edit:undo');
  expect(await page.evaluate(() => [window.pigmentApp.doc.width, window.pigmentApp.doc.height, window.pigmentApp.doc.dpi, window.pigmentApp.doc.mode])).toEqual([400, 300, 72, 'rgb']);
  expect(errors).toEqual([]);
});

test('Duotone shows the ink colours in the composite and saves and reopens as duotone', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  await paint(page, [[0, 0, 100, 300, '#000000'], [100, 0, 100, 300, 'rgb(128,128,128)'], [200, 0, 200, 300, '#ffffff']]);
  await run(page, 'image:mode', 'duotone');
  await expect(dialog(page)).toContainText('Duotone Options');
  // a preset fills in the type and the inks
  await dialog(page).locator('select[data-key="preset"]').selectOption('cyanotype');
  await expect(dialog(page).locator('select[data-key="type"]')).toHaveValue('duotone');
  await expect(dialog(page).locator('input[data-key="ink-name-1"]')).toHaveValue('Prussian Blue');
  // the curve of an ink opens its own editor
  await dialog(page).locator('.duotone-curve-thumb').nth(1).click();
  await expect(dialog(page)).toContainText('Duotone Curve');
  await dialog(page).locator('.dialog-buttons .btn', { hasText: 'Cancel' }).click();
  await expect(dialog(page)).toContainText('Duotone Options');
  await confirmDialog(page);
  await expect.poll(() => mode(page)).toBe('duotone');
  // stored pixels stay grey; the composite shows them through the inks
  expect(await layerPixel(page, 150, 10)).toEqual([128, 128, 128, 255]);
  const mid = await pixel(page, 150, 10);
  expect(mid[2]).toBeGreaterThan(mid[0] + 20); // blue ink
  expect(await pixel(page, 300, 10)).toEqual([255, 255, 255, 255]);
  const dark = await pixel(page, 10, 10);
  expect(dark[0] + dark[1] + dark[2]).toBeLessThan(mid[0] + mid[1] + mid[2]);
  const duotone = await page.evaluate(() => window.pigmentApp.doc.duotone);
  expect(duotone.type).toBe('duotone');
  expect(duotone.inks.map((k) => k.name)).toEqual(['Black', 'Prussian Blue']);
  // the Channels panel lists the single Duotone channel
  await runAwait(page, 'window:panel-channels');
  await expect(page.locator('.channel-list .channel-row .layer-name').first()).toHaveText('Duotone');

  // Duotone again on a duotone document edits the inks (one undoable step)
  const steps = await historyLength(page);
  await runAwait(page, 'image:mode', { mode: 'duotone', options: { duotone: { type: 'monotone', inks: [{ name: 'Red', color: '#ff0000' }] } } });
  expect(await pixel(page, 10, 10)).toEqual([255, 0, 0, 255]);
  expect(await historyLength(page)).toBe(steps + 1);
  await runAwait(page, 'edit:undo');
  expect(await pixel(page, 150, 10)).toEqual(mid);

  // merging layers keeps grey pixels: the inks are a way of looking at them and must not be baked in twice
  await runAwait(page, 'layer:new', { name: 'Top' });
  await paint(page, [[250, 50, 50, 50, 'rgb(128,128,128)']]);
  expect(await pixel(page, 260, 60)).toEqual(mid);
  await runAwait(page, 'image:flatten');
  expect(await page.evaluate(() => window.pigmentApp.doc.layers().length)).toBe(1);
  expect(await layerPixel(page, 260, 60)).toEqual([128, 128, 128, 255]);
  expect(await pixel(page, 260, 60)).toEqual(mid);
  expect(await pixel(page, 150, 10)).toEqual(mid);
  await runAwait(page, 'edit:undo');
  await runAwait(page, 'edit:undo');
  expect(await page.evaluate(() => window.pigmentApp.doc.layers().length)).toBe(1);

  // save as .pigment and reopen: still duotone, same inks, same picture
  await page.evaluate(() => (window.__pigmentTest.nextSavePath = 'browser:/duo/inks.pigment'));
  await runAwait(page, 'file:save-as');
  await expect.poll(() => page.evaluate(() => !!window.__pigmentTest.written['browser:/duo/inks.pigment'])).toBe(true);
  await runAwait(page, 'file:close');
  await runAwait(page, 'file:open-paths', ['browser:/duo/inks.pigment']);
  await expect.poll(() => page.evaluate(() => window.pigmentApp.doc?.path ?? null)).toBe('browser:/duo/inks.pigment');
  expect(await mode(page)).toBe('duotone');
  expect(await page.evaluate(() => window.pigmentApp.doc.duotone)).toEqual(duotone);
  expect(await pixel(page, 150, 10)).toEqual(mid);
  expect(await layerPixel(page, 150, 10)).toEqual([128, 128, 128, 255]);

  // leaving for RGB bakes the ink colours into the pixels
  await runAwait(page, 'image:mode', 'rgb');
  expect(await layerPixel(page, 150, 10)).toEqual(mid);
  expect(await page.evaluate(() => window.pigmentApp.doc.duotone)).toBe(null);
  expect(errors).toEqual([]);
});

test('Save for Web writes a GIF that decodeGif reads back, previews every format, and the GIF reopens indexed', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 120, height: 80 });
  await paint(page, [[0, 0, 60, 40, '#ff0000'], [60, 0, 60, 40, '#00ff00'], [0, 40, 60, 40, '#0000ff'], [60, 40, 60, 40, '#ffff00']]);
  await run(page, 'file:save-for-web');
  await expect(dialog(page)).toContainText('Save for Web');
  await dialog(page).locator('select[data-key="format"]').selectOption('gif');
  await dialog(page).locator('select[data-key="palette"]').selectOption('adaptive');
  await dialog(page).locator('select[data-key="dither"]').selectOption('none');
  const size = dialog(page).locator('[data-role="optimized-size"]');
  await expect(size).toContainText('GIF');
  await expect(dialog(page).locator('[data-role="optimized-info"]')).toContainText('4 colors');
  await expect(dialog(page).locator('[data-role="optimized-info"]')).toContainText('sec @ 56.6 Kbps');
  await expect(dialog(page).locator('.sfw-swatch')).toHaveCount(4);
  const gifSize = Number(await size.getAttribute('data-bytes'));
  // the optimised pane shows the decoded result: same four colours
  const shown = await dialog(page).locator('canvas[data-role="optimized"]').evaluate((c) => Array.from(c.getContext('2d').getImageData(10, 10, 1, 1).data));
  expect(shown).toEqual([255, 0, 0, 255]);
  // the other formats optimise too (their size appears)
  for (const [format, label] of [['jpeg', 'JPEG'], ['png8', 'PNG-8'], ['png24', 'PNG-24'], ['webp', 'WebP']]) {
    await dialog(page).locator('select[data-key="format"]').selectOption(format);
    await expect(size).toContainText(label);
    expect(Number(await size.getAttribute('data-bytes'))).toBeGreaterThan(20);
  }
  // image size: 50% halves both sides
  await dialog(page).locator('select[data-key="format"]').selectOption('gif');
  await setNumber(page, 'percent', 50);
  await expect(dialog(page).locator('input[data-key="width"]')).toHaveValue('60');
  await expect(dialog(page).locator('[data-role="optimized-info"]')).toContainText('60 × 40 px');
  await setNumber(page, 'percent', 100);
  await expect(dialog(page).locator('[data-role="optimized-info"]')).toContainText('120 × 80 px');
  await expect(size).toHaveAttribute('data-bytes', String(gifSize));

  await page.evaluate(() => (window.__pigmentTest.nextSavePath = 'browser:/web/quad.gif'));
  await confirmDialog(page); // Save…
  await expect.poll(() => written(page, 'browser:/web/quad.gif')).not.toBeNull();
  const bytes = Uint8Array.from(await written(page, 'browser:/web/quad.gif'));
  expect(bytes.length).toBe(gifSize);
  const gif = decodeGif(bytes);
  expect([gif.width, gif.height, gif.frames.length]).toEqual([120, 80, 1]);
  const f = gif.frames[0];
  const at = (x, y) => f.palette[f.indices[y * 120 + x]];
  expect(at(10, 10)).toEqual([255, 0, 0]);
  expect(at(100, 10)).toEqual([0, 255, 0]);
  expect(at(10, 70)).toEqual([0, 0, 255]);
  expect(at(100, 70)).toEqual([255, 255, 0]);
  expect(f.transparentIndex).toBe(-1);
  expect(await mode(page)).toBe('rgb'); // Save for Web never changes the document
  expect(await historyLength(page)).toBe(0);

  // opening the GIF keeps its colour table: an Indexed Color document
  await runAwait(page, 'file:open-paths', ['browser:/web/quad.gif']);
  await expect.poll(() => page.evaluate(() => window.pigmentApp.doc?.path ?? null)).toBe('browser:/web/quad.gif');
  expect(await mode(page)).toBe('indexed');
  const table = await page.evaluate(() => window.pigmentApp.doc.colorTable);
  expect(table).toEqual(f.palette);
  expect(await pixel(page, 10, 10)).toEqual([255, 0, 0, 255]);
  expect(await pixel(page, 100, 70)).toEqual([255, 255, 0, 255]);
  // Save As .gif writes a GIF again with the same table, entry for entry
  await runAwait(page, 'image:color-table', { table: table.map((c, i) => (i === f.indices[0] ? [200, 10, 10] : c)), transparentIndex: -1 });
  await page.evaluate(() => (window.__pigmentTest.nextSavePath = 'browser:/web/quad2.gif'));
  await runAwait(page, 'file:save-as');
  await expect.poll(() => written(page, 'browser:/web/quad2.gif')).not.toBeNull();
  const again = decodeGif(Uint8Array.from(await written(page, 'browser:/web/quad2.gif')));
  expect(again.frames[0].palette).toEqual(table.map((c, i) => (i === f.indices[0] ? [200, 10, 10] : c)));
  expect(Array.from(again.frames[0].indices)).toEqual(Array.from(f.indices));
  expect(errors).toEqual([]);
});

test('GIF and PNG-8 export formats, transparency, and a GIF with a transparent index', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 64, height: 48, background: 'transparent' });
  await paint(page, [[0, 0, 32, 48, '#ff0000'], [32, 0, 16, 48, '#0000ff']]); // the last 16 columns stay transparent
  const formats = await page.evaluate(async () => {
    const io = await import('/lib/io.js');
    return { gif: { ...io.SAVE_FORMATS.gif, encode: undefined }, png8: { ...io.SAVE_FORMATS.png8, encode: undefined }, route: io.exportFormatForPath('x.png')?.id, gifRoute: io.exportFormatForPath('x.gif')?.id, writable: io.canWritePath('a.gif') };
  });
  expect(formats.gif.name).toBe('GIF image');
  expect(formats.gif.ext).toBe('gif');
  expect(formats.gif.options.map((o) => o.key)).toEqual(['colors', 'dither', 'transparency', 'matte']);
  expect(formats.png8.ext).toBe('png');
  expect(formats.png8.extensions).toEqual([]);
  expect(formats.png8.options.map((o) => o.key)).toEqual(['colors', 'dither', 'transparency', 'matte']);
  expect(formats.route).toBe('png'); // .png still means PNG-24
  expect(formats.gifRoute).toBe('gif');
  expect(formats.writable).toBe(true);

  await runAwait(page, 'file:export', { path: 'browser:/out/a.gif', format: 'gif', colors: 8, dither: 'none', transparency: true, matte: '#ffffff' });
  await expect.poll(() => written(page, 'browser:/out/a.gif')).not.toBeNull();
  const gif = decodeGif(Uint8Array.from(await written(page, 'browser:/out/a.gif')));
  const f = gif.frames[0];
  expect(f.palette[f.indices[0]]).toEqual([255, 0, 0]);
  expect(f.palette[f.indices[40]]).toEqual([0, 0, 255]);
  expect(f.transparentIndex).toBeGreaterThanOrEqual(0);
  expect(f.indices[60]).toBe(f.transparentIndex);

  await runAwait(page, 'file:export', { path: 'browser:/out/a.png', format: 'png8', colors: 8, dither: 'none', transparency: true, matte: '#ffffff' });
  await expect.poll(() => written(page, 'browser:/out/a.png')).not.toBeNull();
  const png = await decodePng(Uint8Array.from(await written(page, 'browser:/out/a.png')));
  expect(png.colorType).toBe(3); // palette
  const rgba = toRgba8(png);
  expect(Array.from(rgba.data.slice(0, 4))).toEqual([255, 0, 0, 255]);
  expect(Array.from(rgba.data.slice(40 * 4, 40 * 4 + 4))).toEqual([0, 0, 255, 255]);
  expect(rgba.data[60 * 4 + 3]).toBe(0);
  // transparency off: everything sits on the matte
  await runAwait(page, 'file:export', { path: 'browser:/out/b.gif', format: 'gif', colors: 8, dither: 'none', transparency: false, matte: '#00ff00' });
  await expect.poll(() => written(page, 'browser:/out/b.gif')).not.toBeNull();
  const flat = decodeGif(Uint8Array.from(await written(page, 'browser:/out/b.gif'))).frames[0];
  expect(flat.transparentIndex).toBe(-1);
  expect(flat.palette[flat.indices[60]]).toEqual([0, 255, 0]);

  // the PNG-8 opens as Indexed Color as well, with its palette and its transparent entry
  await runAwait(page, 'file:open-paths', ['browser:/out/a.png']);
  await expect.poll(() => page.evaluate(() => window.pigmentApp.doc?.path ?? null)).toBe('browser:/out/a.png');
  const opened = await page.evaluate(() => ({ mode: window.pigmentApp.doc.mode, table: window.pigmentApp.doc.colorTable, ti: window.pigmentApp.modes.state(window.pigmentApp.doc).transparentIndex }));
  expect(opened.mode).toBe('indexed');
  expect(opened.table.slice(0, 2).map((c) => c.join(',')).sort()).toEqual(['0,0,255', '255,0,0']);
  expect(opened.ti).toBe(2);
  expect(await pixel(page, 2, 2)).toEqual([255, 0, 0, 255]);
  expect((await pixel(page, 60, 2))[3]).toBe(0);
  await runAwait(page, 'file:close');
  await expect.poll(() => page.evaluate(() => window.pigmentApp.doc?.name ?? null)).toBe('Test');

  // Export As offers both formats and shows their option fields only for them
  await run(page, 'file:export');
  await expect(dialog(page).locator('select[data-key="format"] option[value="gif"]')).toHaveCount(1);
  await expect(dialog(page).locator('select[data-key="format"] option[value="png8"]')).toHaveCount(1);
  await dialog(page).locator('select[data-key="format"]').selectOption('gif');
  await expect(dialog(page).locator('input[data-key="colors"]:visible')).toHaveCount(1);
  await dialog(page).locator('select[data-key="format"]').selectOption('png');
  await expect(dialog(page).locator('input[data-key="colors"]:visible')).toHaveCount(0);
  await dialog(page).locator('.dialog-buttons .btn', { hasText: 'Cancel' }).click();
  await expectNoDialog(page);

  // a GIF with a transparent index opens indexed, keeps the index, and shows those pixels transparent
  const palette = [[10, 20, 30], [200, 100, 50], [0, 0, 0], [255, 255, 255]];
  const indices = Uint8Array.from({ length: 16 * 8 }, (_, i) => (i % 16 < 4 ? 2 : i % 16 < 10 ? 1 : 0));
  const bytes = encodeGif([{ indices, palette, transparentIndex: 2 }], 16, 8);
  await page.evaluate((b) => (window.__pigmentTest.files['browser:/in/t.gif'] = Uint8Array.from(b)), Array.from(bytes));
  await runAwait(page, 'file:open-paths', ['browser:/in/t.gif']);
  await expect.poll(() => page.evaluate(() => window.pigmentApp.doc?.path ?? null)).toBe('browser:/in/t.gif');
  expect(await page.evaluate(() => [window.pigmentApp.doc.mode, window.pigmentApp.doc.colorTable, window.pigmentApp.modes.state(window.pigmentApp.doc).transparentIndex])).toEqual(['indexed', palette, 2]);
  expect((await pixel(page, 1, 1))[3]).toBe(0);
  expect(await pixel(page, 6, 1)).toEqual([200, 100, 50, 255]);
  expect(await pixel(page, 12, 1)).toEqual([10, 20, 30, 255]);
  // Color Table marks the transparent entry
  await run(page, 'image:color-table');
  await expect(dialog(page).locator('.ct-cell.transparent')).toHaveCount(1);
  await expect(dialog(page).locator('.ct-cell.transparent')).toHaveAttribute('data-index', '2');
  await dialog(page).locator('.dialog-buttons .btn', { hasText: 'Cancel' }).click();
  expect(errors).toEqual([]);
});

test('the New Document dialog makes a grayscale document whose picked colours are grey', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page); // an RGB document to come back to
  await page.evaluate(() => window.pigmentApp.setColors({ foreground: '#ff0000', background: '#00ff00' }));
  await run(page, 'file:new');
  await expect(dialog(page)).toContainText('New Document');
  await dialog(page).locator('select[data-key="mode"]').selectOption('grayscale');
  await confirmDialog(page);
  await expect.poll(() => page.evaluate(() => window.pigmentApp.docs.list().length)).toBe(2);
  expect(await mode(page)).toBe('grayscale');
  // the colours picked before show (and paint) as their greys in this document
  expect(await page.evaluate(() => [window.pigmentApp.settings.foreground, window.pigmentApp.settings.background])).toEqual(['#4c4c4c', '#969696']);
  await page.evaluate(() => window.pigmentApp.setColors({ foreground: '#0000ff' }));
  expect(await page.evaluate(() => window.pigmentApp.settings.foreground)).toBe('#1d1d1d');
  // painting with a colour gives grey pixels
  await runAwait(page, 'edit:fill', { use: 'color', color: '#ff0000', opacity: 100, blend: 'normal', preserve: false });
  const p = await pixel(page, 5, 5);
  expect(p[0] === p[1] && p[1] === p[2]).toBe(true);
  // the menu state follows the document
  expect(await page.evaluate(() => window.pigmentApp.uiState.mode)).toBe('grayscale');
  // back in the RGB document colours are free again
  await page.evaluate(() => window.pigmentApp.docs.activate(window.pigmentApp.docs.list()[0]));
  expect(await mode(page)).toBe('rgb');
  await page.evaluate(() => window.pigmentApp.setColors({ foreground: '#ff0000' }));
  expect(await page.evaluate(() => window.pigmentApp.settings.foreground)).toBe('#ff0000');
  expect(errors).toEqual([]);
});

test('picked colours come back when a colour document is activated again', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  await page.evaluate(() => window.pigmentApp.setColors({ foreground: '#ff0000', background: '#0000ff' }));
  await page.evaluate(() => window.pigmentApp.newDocument({ width: 50, height: 50, name: 'Grey', mode: 'grayscale' }));
  expect(await page.evaluate(() => [window.pigmentApp.settings.foreground, window.pigmentApp.settings.background])).toEqual(['#4c4c4c', '#1d1d1d']);
  await page.evaluate(() => window.pigmentApp.docs.activate(window.pigmentApp.docs.list()[0]));
  expect(await page.evaluate(() => [window.pigmentApp.settings.foreground, window.pigmentApp.settings.background])).toEqual(['#ff0000', '#0000ff']);
  expect(errors).toEqual([]);
});

test('CMYK, Lab and Multichannel: derived channels in the Channels panel, Ctrl-click loads them, Trap', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  await paint(page, [[0, 0, 200, 300, '#ffff00'], [200, 0, 200, 300, '#0000ff']]);
  await runAwait(page, 'window:panel-channels');
  const names = () => page.locator('.channel-list .channel-row .layer-name').allTextContents();
  expect(await names()).toEqual(['RGB', 'Red', 'Green', 'Blue']);

  await runAwait(page, 'image:mode', 'cmyk');
  expect(await mode(page)).toBe('cmyk');
  expect(await layerPixel(page, 10, 10)).toEqual([255, 255, 0, 255]); // stored pixels are untouched
  await expect.poll(names).toEqual(['CMYK', 'Cyan', 'Magenta', 'Yellow', 'Black']);
  // Ctrl-click Yellow: the yellow half carries full ink (drawn black, not selected), the blue half none
  await page.locator('.channel-row[data-channel="y"]').click({ modifiers: ['Control'] });
  const sel = await page.evaluate(() => {
    const s = window.pigmentApp.doc.selection;
    return s ? [s.mask[10 * 400 + 10], s.mask[10 * 400 + 300]] : null;
  });
  expect(sel).toEqual([0, 255]);
  // and Cyan: only the blue half has cyan ink, so only the yellow half is selected
  await page.locator('.channel-row[data-channel="c"]').click({ modifiers: ['Control'] });
  expect(await page.evaluate(() => [window.pigmentApp.doc.selection.mask[10 * 400 + 10], window.pigmentApp.doc.selection.mask[10 * 400 + 300]])).toEqual([255, 0]);
  await runAwait(page, 'select:none');

  // Trap (CMYK only): the lighter yellow spreads under the darker blue at their boundary
  expect(await page.evaluate(() => window.pigmentApp.commands.isEnabled('image:trap'))).toBe(true);
  await run(page, 'image:trap');
  await expect(dialog(page)).toContainText('Trap');
  await setNumber(page, 'width', 2);
  const steps = await historyLength(page);
  await confirmDialog(page);
  await expect.poll(() => historyLength(page)).toBe(steps + 1);
  expect(await pixel(page, 199, 100)).toEqual([255, 255, 0, 255]);
  expect(await pixel(page, 200, 100)).toEqual([0, 0, 0, 255]); // blue + yellow ink
  expect(await pixel(page, 201, 100)).toEqual([0, 0, 0, 255]);
  expect(await pixel(page, 202, 100)).toEqual([0, 0, 255, 255]);
  await runAwait(page, 'edit:undo');
  expect(await pixel(page, 200, 100)).toEqual([0, 0, 255, 255]);

  await runAwait(page, 'image:mode', 'lab');
  await expect.poll(names).toEqual(['Lab', 'Lightness', 'a', 'b']);
  expect(await page.evaluate(() => window.pigmentApp.commands.isEnabled('image:trap'))).toBe(false);
  await page.locator('.channel-row[data-channel="L"]').click({ modifiers: ['Control'] });
  const light = await page.evaluate(() => [window.pigmentApp.doc.selection.mask[10 * 400 + 10], window.pigmentApp.doc.selection.mask[10 * 400 + 300]]);
  expect(light[0]).toBeGreaterThan(240); // yellow: L 97
  expect(Math.abs(light[1] - 82)).toBeLessThanOrEqual(2); // blue: L 32
  await runAwait(page, 'select:none');

  // Multichannel from CMYK: four spot channels; deleting one stops that ink printing
  await runAwait(page, 'image:mode', 'cmyk');
  await runAwait(page, 'image:mode', 'multichannel');
  expect(await mode(page)).toBe('multichannel');
  await expect.poll(names).toEqual(['Cyan', 'Magenta', 'Yellow', 'Black']);
  await expect(page.locator('.channel-row .channel-ink')).toHaveCount(4);
  expect(await pixel(page, 10, 10)).toEqual([255, 255, 0, 255]);
  const yellowPlane = await page.evaluate(() => {
    const ch = window.pigmentApp.doc.channels.find((c) => c.name === 'Yellow');
    return [ch.mask[10 * 400 + 10], ch.mask[10 * 400 + 300], ch.spot.key];
  });
  expect(yellowPlane).toEqual([0, 255, 'y']);
  await page.locator('.channel-row', { hasText: 'Yellow' }).click();
  await page.locator('.channels-panel [data-act="delete"]').click();
  await expect.poll(names).toEqual(['Cyan', 'Magenta', 'Black']);
  await expect.poll(() => pixel(page, 10, 10)).toEqual([255, 255, 255, 255]); // yellow area without yellow ink: paper
  expect(await pixel(page, 300, 10)).toEqual([0, 0, 255, 255]);
  await runAwait(page, 'edit:undo');
  await expect.poll(() => pixel(page, 10, 10)).toEqual([255, 255, 0, 255]);
  // back to RGB drops the spot channels
  await runAwait(page, 'image:mode', 'rgb');
  expect(await page.evaluate(() => window.pigmentApp.doc.channels.length)).toBe(0);
  await expect.poll(names).toEqual(['RGB', 'Red', 'Green', 'Blue']);
  expect(errors).toEqual([]);
});

test('Conditional Mode Change converts only from the chosen source modes and replays without a dialog', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  await paint(page, [[0, 0, 400, 300, '#ff0000']]);
  await run(page, 'file:automate-conditional-mode');
  await expect(dialog(page)).toContainText('Conditional Mode Change');
  // the current mode is ticked to begin with
  await expect(dialog(page).locator('input[data-key="src-rgb"]')).toBeChecked();
  await expect(dialog(page).locator('input[data-key="src-cmyk"]')).not.toBeChecked();
  await dialog(page).locator('[data-act="all"]').click();
  await expect(dialog(page).locator('input[data-key="src-cmyk"]')).toBeChecked();
  await dialog(page).locator('[data-act="none"]').click();
  await expect(dialog(page).locator('input[data-key="src-rgb"]')).not.toBeChecked();
  await dialog(page).locator('input[data-key="src-rgb"]').check();
  await dialog(page).locator('select[data-key="target"]').selectOption('grayscale');
  const done = page.evaluate(() => new Promise((resolve) => {
    const off = window.pigmentApp.on('command:done', (e) => {
      if (e.id !== 'file:automate-conditional-mode') return;
      off();
      resolve({ arg: e.arg, replayable: e.replayable, cancelled: e.cancelled });
    });
  }));
  await confirmDialog(page);
  await expect.poll(() => mode(page)).toBe('grayscale');
  expect(await pixel(page, 5, 5)).toEqual([76, 76, 76, 255]);
  // what an action records: the sources and the target
  expect(await done).toEqual({ arg: { sources: ['rgb'], target: 'grayscale' }, replayable: true, cancelled: false });
  // replay on a document that is not in a source mode: nothing happens
  const steps = await historyLength(page);
  expect(await runAwait(page, 'file:automate-conditional-mode', { sources: ['rgb'], target: 'cmyk' })).toBe(false);
  expect(await mode(page)).toBe('grayscale');
  expect(await historyLength(page)).toBe(steps);
  // and from a source mode it converts silently, flattening when the target needs it
  await runAwait(page, 'layer:new', { name: 'Top' });
  expect(await runAwait(page, 'file:automate-conditional-mode', { sources: ['grayscale', 'rgb'], target: 'indexed' })).toBe(true);
  await expectNoDialog(page);
  expect(await mode(page)).toBe('indexed');
  expect(await page.evaluate(() => window.pigmentApp.doc.layers().length)).toBe(1);

  // a played action never stops to ask: a layered document is converted layer by layer, a flattening mode flattens
  await runAwait(page, 'image:mode', 'rgb');
  await runAwait(page, 'layer:new', { name: 'Top' });
  expect(await page.evaluate(() => window.pigmentApp.commands.run('image:mode', 'grayscale', 'action'))).toBe(true);
  await expectNoDialog(page);
  expect(await page.evaluate(() => [window.pigmentApp.doc.mode, window.pigmentApp.doc.layers().length])).toEqual(['grayscale', 2]);
  expect(await page.evaluate(() => window.pigmentApp.commands.run('image:mode', 'bitmap', 'action'))).toBe(true);
  await expectNoDialog(page);
  expect(await page.evaluate(() => [window.pigmentApp.doc.mode, window.pigmentApp.doc.layers().length])).toEqual(['bitmap', 1]);
  // without a mode the command asks for one
  await run(page, 'image:mode');
  await expect(dialog(page).locator('select[data-key="mode"]')).toBeVisible();
  await dialog(page).locator('select[data-key="mode"]').selectOption('grayscale');
  await confirmDialog(page);
  await expect.poll(() => mode(page)).toBe('grayscale');

  // image:mode reports a replayable argument too, so recorded actions convert without asking
  const replay = page.evaluate(() => new Promise((resolve) => {
    const off = window.pigmentApp.on('command:done', (e) => {
      if (e.id !== 'image:mode') return;
      off();
      resolve(e.arg);
    });
  }));
  await runAwait(page, 'image:mode', 'rgb');
  expect(await replay).toEqual({ mode: 'rgb', flatten: false, options: {} });
  expect(errors).toEqual([]);
});

/** Types a hex colour into the open colour picker and confirms it. */
const pickHex = async (page, hex) => {
  const dlg = page.locator('.color-picker-dialog').last();
  const red = String(parseInt(hex.slice(1, 3), 16));
  // the picker settles its fields a frame after opening: type until the colour has taken
  await expect(async () => {
    await dlg.locator('[data-f="hex"]').fill(hex.replace('#', ''));
    await dlg.locator('[data-f="hex"]').blur(); // commits the field (Enter would also press OK)
    await expect(dlg.locator('[data-f="hex"]')).toHaveValue(hex.replace('#', ''), { timeout: 500 });
    await expect(dlg.locator('[data-f="r"]')).toHaveValue(red, { timeout: 500 });
  }).toPass({ timeout: 10000 });
  await dlg.locator('.dialog-buttons .btn.primary').click();
};
const cellColor = (page, index) => page.locator(`.ct-cell[data-index="${index}"]`).evaluate((c) => getComputedStyle(c).backgroundColor.match(/\d+/g).slice(0, 3).map(Number));

test('Color Table editor: click to change, drag a range for a gradient, add a colour, pick the transparent entry', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  await quadrants(page);
  await runAwait(page, 'image:mode', { mode: 'indexed', options: { palette: 'custom', custom: [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0]], dither: 'none' } });
  expect(await page.evaluate(() => window.pigmentApp.doc.colorTable)).toEqual([[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0]]);
  await run(page, 'image:color-table');
  const table = page.locator('.color-table-dialog');
  await expect(table.locator('.ct-cell.filled')).toHaveCount(4);
  // hovering describes the entry
  await table.locator('.ct-cell[data-index="2"]').hover();
  await expect(table.locator('.ct-info')).toContainText('Index 2: #0000ff');
  // click: the colour picker changes one entry
  await table.locator('.ct-cell[data-index="0"]').click();
  await pickHex(page, '#102030');
  await expect.poll(() => cellColor(page, 0)).toEqual([16, 32, 48]);
  await expect(table.locator('select[data-key="ct-preset"]')).toHaveValue('custom');
  // drag over entries 0..3: two pickers (first and last colour), then a gradient between them
  const a = await table.locator('.ct-cell[data-index="0"]').boundingBox();
  const b = await table.locator('.ct-cell[data-index="3"]').boundingBox();
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 6 });
  await expect(table.locator('.ct-cell.in-range')).toHaveCount(4);
  await page.mouse.up();
  await expect(page.locator('.color-picker-dialog')).toContainText('Select first color');
  await pickHex(page, '#000000');
  await expect(page.locator('.color-picker-dialog')).toContainText('Select last color');
  await pickHex(page, '#ffffff');
  await expect.poll(() => cellColor(page, 1)).toEqual([85, 85, 85]);
  expect(await cellColor(page, 0)).toEqual([0, 0, 0]);
  expect(await cellColor(page, 2)).toEqual([170, 170, 170]);
  expect(await cellColor(page, 3)).toEqual([255, 255, 255]);
  // the first empty cell adds a colour
  await table.locator('.ct-cell[data-index="4"]').click();
  await pickHex(page, '#ff00ff');
  await expect(table.locator('.ct-cell.filled')).toHaveCount(5);
  // the Transparency eyedropper marks an entry; clicking it again clears it
  await table.locator('[data-act="transparency"]').click();
  await table.locator('.ct-cell[data-index="1"]').click();
  await expect(table.locator('.ct-cell.transparent')).toHaveAttribute('data-index', '1');
  await table.locator('[data-act="transparency"]').click();
  await table.locator('.ct-cell[data-index="1"]').click();
  await expect(table.locator('.ct-cell.transparent')).toHaveCount(0);
  await table.locator('[data-act="transparency"]').click();
  await table.locator('.ct-cell[data-index="1"]').click();
  await expect(table.locator('.ct-cell.transparent')).toHaveCount(1);
  await confirmDialog(page);
  await expect.poll(() => page.evaluate(() => window.pigmentApp.doc.colorTable)).toEqual([[0, 0, 0], [85, 85, 85], [170, 170, 170], [255, 255, 255], [255, 0, 255]]);
  expect(await page.evaluate(() => window.pigmentApp.modes.state(window.pigmentApp.doc).transparentIndex)).toBe(1);
  // pixels kept their index: red (0) is black now, green (1) is transparent, blue (2) and yellow (3) are greys
  expect(await pixel(page, 10, 10)).toEqual([0, 0, 0, 255]);
  expect((await pixel(page, 300, 10))[3]).toBe(0);
  expect(await pixel(page, 10, 200)).toEqual([170, 170, 170, 255]);
  expect(await pixel(page, 300, 200)).toEqual([255, 255, 255, 255]);
  expect(await historyLength(page)).toBe(2);
  await runAwait(page, 'edit:undo');
  expect(await pixel(page, 300, 10)).toEqual([0, 255, 0, 255]);
  expect(errors).toEqual([]);
});

test('Indexed Color with a custom table edited in the dialog, and a duotone ink curve shaped by hand', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  await quadrants(page);
  await run(page, 'image:mode', 'indexed');
  // four flat colours: Photoshop proposes the exact palette
  await expect(dialog(page).locator('select[data-key="palette"]')).toHaveValue('exact');
  await expect(dialog(page).locator('input[data-key="colors"]')).toBeDisabled();
  await dialog(page).locator('select[data-key="palette"]').selectOption('custom');
  await dialog(page).locator('[data-act="edit-table"]').click();
  const table = page.locator('.color-table-dialog');
  await expect(table).toContainText('Custom Color Table');
  await table.locator('select[data-key="ct-preset"]').selectOption('grayscale');
  await table.locator('.dialog-buttons .btn.primary').click();
  await expect(page.locator('.color-table-dialog')).toHaveCount(0);
  await expect(dialog(page)).toContainText('256 colors');
  await dialog(page).locator('select[data-key="dither"]').selectOption('none');
  await confirmDialog(page);
  await expect.poll(() => mode(page)).toBe('indexed');
  const info = await page.evaluate(() => ({ n: window.pigmentApp.doc.colorTable.length, grey: window.pigmentApp.doc.colorTable.every((c) => c[0] === c[1] && c[1] === c[2]) }));
  expect(info).toEqual({ n: 256, grey: true });
  const red = await pixel(page, 10, 10);
  expect(red[0] === red[1] && red[1] === red[2]).toBe(true);
  await runAwait(page, 'edit:undo');

  // Duotone: a monotone whose curve is pulled up prints more ink in the mid tones
  await paint(page, [[0, 0, 400, 300, 'rgb(128,128,128)']]);
  await run(page, 'image:mode', 'duotone');
  await dialog(page).locator('select[data-key="type"]').selectOption('monotone');
  await expect(dialog(page).locator('.duotone-ink.off')).toHaveCount(3);
  await dialog(page).locator('.duotone-curve-thumb').first().click();
  const editor = page.locator('.duotone-curve-editor');
  const box = await editor.boundingBox();
  // a new point at grey 50% → ink 90%
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.1);
  await expect(dialog(page).locator('input[data-key="curve-in"]')).toHaveValue('50');
  await expect(dialog(page).locator('input[data-key="curve-out"]')).toHaveValue('90');
  await dialog(page).locator('.dialog-buttons .btn.primary').click(); // the curve
  await expect(page.locator('.duotone-curve-editor')).toHaveCount(0);
  await confirmDialog(page); // Duotone Options
  await expect.poll(() => mode(page)).toBe('duotone');
  const curve = await page.evaluate(() => window.pigmentApp.doc.duotone.inks[0].curve);
  expect(curve.length).toBe(3);
  expect(Math.abs(curve[1][0] - 50)).toBeLessThanOrEqual(1);
  expect(Math.abs(curve[1][1] - 90)).toBeLessThanOrEqual(1);
  // black ink at ~90% coverage on mid grey: about 10% of paper white
  const p = await pixel(page, 100, 100);
  expect(p[0]).toBeLessThan(40);
  expect(p[0]).toBeGreaterThan(15);
  expect(await layerPixel(page, 100, 100)).toEqual([128, 128, 128, 255]);
  expect(errors).toEqual([]);
});

test('the Index channel of an indexed document shows the table size and opens the Color Table', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  await quadrants(page);
  await runAwait(page, 'image:mode', { mode: 'indexed', options: { palette: 'exact', dither: 'none' } });
  await runAwait(page, 'window:panel-channels');
  const row = page.locator('.channel-list .channel-row').first();
  await expect(row.locator('.layer-name')).toHaveText('Index');
  await expect(row).toContainText('4 colors');
  await expect(page.locator('.channel-list')).toHaveAttribute('data-mode', 'indexed');
  // Ctrl-click still loads the channel: the luminosity of what is shown (yellow is light, blue is dark)
  await row.click({ modifiers: ['Control'] });
  const sel = await page.evaluate(() => {
    const m = window.pigmentApp.doc.selection.mask;
    return [m[200 * 400 + 300], m[200 * 400 + 100]];
  });
  expect(sel[0]).toBeGreaterThan(200);
  expect(sel[1]).toBeLessThan(60);
  await row.dblclick();
  await expect(page.locator('.color-table-dialog .ct-cell.filled')).toHaveCount(4);
  await page.locator('.color-table-dialog .dialog-buttons .btn', { hasText: 'Cancel' }).click();
  await expectNoDialog(page);
  expect(errors).toEqual([]);
});
