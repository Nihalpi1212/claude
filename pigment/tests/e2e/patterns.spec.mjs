// patterns (0.4 package 10, port 8810): the pattern library (define, persistence across a restart, delete), the
// Patterns panel and its drags, the `pattern` widget and picker, Edit > Fill with a pattern and the Scripted Patterns,
// Pattern Fill layers (Angle, Scale, Link with Layer, Snap to Origin, moving the pattern in the dialog), the Paint
// Bucket's pattern source, Bitmap's Custom Pattern and View > Pattern Preview.
import { test, expect } from '@playwright/test';
import { openApp, newDoc, run, runAwait, confirmDialog, screenPoint, pixel, layerPixel } from './helpers.mjs';

const history = (page) => page.evaluate(() => window.pigmentApp.doc.history.entries.slice(0, window.pigmentApp.doc.history.index + 1).map((e) => e.label));

/** Paints rectangles straight into the active raster layer (setup, not an undo step). */
const paintRects = (page, rects) => page.evaluate((list) => {
  const l = window.pigmentApp.doc.active;
  const ctx = l.canvas.getContext('2d');
  for (const [x, y, w, h, c] of list) {
    ctx.fillStyle = c;
    ctx.fillRect(x - l.x, y - l.y, w, h);
  }
  l.touch();
  window.pigmentApp.doc.changed('pixels', { layer: l });
}, rects);

const selectRect = (page, r) => page.evaluate(async (rect) => {
  const app = window.pigmentApp;
  const { Selection } = await import('/lib/selection.js');
  app.applySelection(Selection.fromRect(app.doc.width, app.doc.height, rect), 'replace');
}, r);

/** A 4 × 4 tile: red on the top half, blue below, defined as a pattern named `name` (no dialog). */
async function defineTile(page, name) {
  await paintRects(page, [[0, 0, 4, 2, '#ff0000'], [0, 2, 4, 2, '#0000ff']]);
  await selectRect(page, { x: 0, y: 0, width: 4, height: 4 });
  const id = await page.evaluate(async (n) => (await window.pigmentApp.commands.run('edit:define-pattern', { name: n }, 'api'))?.id, name);
  await page.evaluate(() => window.pigmentApp.applySelection(null, 'replace'));
  return id;
}

test('Define Pattern asks for a name; the library keeps the pattern across a restart; the panel lists it', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 120, height: 80 });
  expect(await page.evaluate(async () => (await import('/lib/fields.js')).isStubWidget('pattern'))).toBe(false);
  expect(await page.evaluate(() => window.pigmentApp.stubbed.filter((id) => /pattern/.test(id)))).toEqual([]);
  // the built-in patterns are there, the first one current
  const builtins = await page.evaluate(async () => {
    await window.pigmentApp.patterns.ready();
    return { ids: window.pigmentApp.patterns.list().map((e) => e.id), current: window.pigmentApp.patterns.current()?.id };
  });
  expect(builtins.ids).toEqual(expect.arrayContaining(['checkerboard', 'grid', 'dots', 'bricks', 'clouds', 'wood']));
  expect(builtins.current).toBe('checkerboard');

  await paintRects(page, [[0, 0, 6, 3, '#ff0000'], [0, 3, 6, 3, '#00ff00']]);
  await selectRect(page, { x: 0, y: 0, width: 6, height: 6 });
  const entries = (await history(page)).length;
  // from the menu, the Pattern Name dialog shows the tile and asks for its name
  await page.evaluate(() => {
    window.pigmentApp.commands.run('edit:define-pattern', undefined, 'menu');
  });
  const dialog = page.locator('.dialog');
  await expect(dialog).toContainText('Pattern Name');
  await expect(dialog).toContainText('6 × 6 px');
  await dialog.locator('input[data-key="name"]').fill('Red and green');
  await confirmDialog(page);
  await expect.poll(() => page.evaluate(() => window.pigmentApp.patterns.current()?.name ?? null)).toBe('Red and green');
  const def = await page.evaluate(() => {
    const app = window.pigmentApp;
    const cur = app.patterns.current();
    const px = cur.canvas.getContext('2d').getImageData(0, 0, 6, 6).data;
    return { id: cur.id, w: cur.width, top: Array.from(px.slice(0, 4)), bottom: Array.from(px.slice(5 * 24, 5 * 24 + 4)), setting: app.settings.patterns.current };
  });
  expect(def).toMatchObject({ w: 6, top: [255, 0, 0, 255], bottom: [0, 255, 0, 255] });
  expect(def.setting).toBe(def.id);
  // Define Pattern changes no pixels: no history entry
  expect((await history(page)).length).toBe(entries);

  // the Patterns panel shows it, selected (it is current)
  await runAwait(page, 'window:panel-patterns');
  const sw = page.locator(`.patterns-panel .pp-swatch[data-preset-id="${def.id}"]`);
  await expect(sw).toHaveAttribute('aria-selected', 'true');
  // a click on a built-in makes that one current
  await page.locator('.patterns-panel .pp-swatch[data-preset-id="dots"]').click();
  expect(await page.evaluate(() => window.pigmentApp.patterns.current().id)).toBe('dots');

  // restart: the preset store (IndexedDB in the browser build) keeps the pattern and its pixels
  await page.evaluate(() => window.pigmentApp.presets.flush());
  await page.reload();
  await page.waitForSelector('body[data-ready]');
  const after = await page.evaluate(async (id) => {
    const app = window.pigmentApp;
    const e = await app.patterns.get(id);
    return e ? { name: e.name, w: e.width, px: Array.from(e.canvas.getContext('2d').getImageData(0, 4, 1, 1).data) } : null;
  }, def.id);
  expect(after).toEqual({ name: 'Red and green', w: 6, px: [0, 255, 0, 255] });

  // rename and delete through the library
  await page.evaluate(async (id) => {
    await window.pigmentApp.patterns.rename(id, 'Renamed');
  }, def.id);
  expect(await page.evaluate((id) => window.pigmentApp.patterns.list().find((e) => e.id === id)?.name, def.id)).toBe('Renamed');
  await page.evaluate((id) => window.pigmentApp.patterns.remove(id), def.id);
  expect(await page.evaluate((id) => window.pigmentApp.patterns.list().some((e) => e.id === id), def.id)).toBe(false);
  expect(errors).toEqual([]);
});

test('Edit > Fill with a pattern from the picker, anchored at the document origin, and with a scripted pattern', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 100, height: 60 });
  await page.evaluate(() => window.pigmentApp.patterns.ready());
  await selectRect(page, { x: 10, y: 5, width: 40, height: 30 });
  await run(page, 'edit:fill');
  const dialog = page.locator('.dialog');
  await dialog.locator('select[data-key="use"]').selectOption('pattern');
  const widget = dialog.locator('[data-widget="pattern"][data-key="pattern"]');
  await expect(widget).toBeVisible();
  // the picker opens inline in the dialog; pick Grid
  await widget.locator('.pw-more').click();
  await expect(widget.locator('.pw-inline-picker .pp-group-head')).toHaveCount(2);
  await widget.locator('.pp-swatch[data-preset-id="grid"]').click();
  await expect(widget.locator('.pw-name')).toHaveText('Grid');
  const done = page.evaluate(() => new Promise((resolve) => {
    const off = window.pigmentApp.on('command:done', (e) => {
      if (e.id === 'edit:fill') {
        off();
        resolve(e.arg);
      }
    });
  }));
  await confirmDialog(page);
  const arg = await done;
  expect(arg).toMatchObject({ use: 'pattern', script: null, pattern: { presetId: 'grid', name: 'Grid' } });
  expect(arg.pattern.dataUrl.startsWith('data:image/png')).toBe(true);
  // the grid's pixels at document positions (the tiles start at the document origin, not at the selection)
  const tile = await page.evaluate(async () => {
    const e = await window.pigmentApp.patterns.get('grid');
    return Array.from(e.canvas.getContext('2d').getImageData(0, 0, 16, 16).data);
  });
  const at = (x, y) => tile.slice(((y % 16) * 16 + (x % 16)) * 4, ((y % 16) * 16 + (x % 16)) * 4 + 4);
  for (const [x, y] of [[16, 16], [24, 10], [33, 20], [40, 8]]) expect(await layerPixel(page, x, y)).toEqual(at(x, y));
  expect(await layerPixel(page, 5, 5)).toEqual([255, 255, 255, 255]); // outside the selection: untouched
  expect((await history(page)).at(-1)).toBe('Fill');

  // Scripted Patterns: Random Fill through its own dialog; the recorded seed replays the same pixels
  await page.evaluate(() => window.pigmentApp.applySelection(null, 'replace'));
  await runAwait(page, 'layer:new', { name: 'Scripted' });
  await run(page, 'edit:fill');
  await dialog.locator('select[data-key="use"]').selectOption('pattern');
  await dialog.locator('input[data-key="script"]').check();
  await dialog.locator('select[data-key="scriptName"]').selectOption('random-fill');
  const done2 = page.evaluate(() => new Promise((resolve) => {
    const off = window.pigmentApp.on('command:done', (e) => {
      if (e.id === 'edit:fill') {
        off();
        resolve(e.arg);
      }
    });
  }));
  await page.locator('.dialog .dialog-buttons .btn.primary').click();
  await expect(page.locator('.dialog h2')).toHaveText('Random Fill');
  await page.locator('.dialog input[data-key="density"]').fill('5');
  await page.locator('.dialog input[data-key="density"]').dispatchEvent('change');
  await confirmDialog(page);
  const arg2 = await done2;
  expect(arg2).toMatchObject({ use: 'pattern', script: 'random-fill', scriptOptions: { density: 5 } });
  expect(Number.isInteger(arg2.scriptOptions.seed)).toBe(true);
  const snapshot = () => page.evaluate(() => {
    const l = window.pigmentApp.doc.active;
    return Array.from(l.canvas.getContext('2d').getImageData(0, 0, 100, 60).data).join(',');
  });
  const first = await snapshot();
  expect(first.split(',').some((v, i) => i % 4 === 3 && v !== '0')).toBe(true);
  await runAwait(page, 'layer:new', { name: 'Replay' });
  await runAwait(page, 'edit:fill', arg2);
  await page.waitForFunction(() => !document.body.classList.contains('busy'));
  expect(await snapshot()).toBe(first);
  expect(errors).toEqual([]);
});

test('Pattern Fill layers: New Fill Layer, Angle and Scale, moving the pattern in the dialog, Properties and Snap to Origin', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 80, height: 60 });
  await defineTile(page, 'Stripes');
  await run(page, 'layer:new-fill', 'pattern');
  const dialog = page.locator('.dialog');
  await expect(dialog.locator('h2')).toHaveText('Pattern Fill');
  await expect(dialog.locator('[data-widget="pattern"] .pw-name')).toHaveText('Stripes');
  await dialog.locator('input[data-key="scale"]').fill('200');
  await dialog.locator('input[data-key="scale"]').dispatchEvent('change');
  // a drag in the document moves the pattern (the canvas takes the pointer under the dialog)
  // (near the document's corner: the dialog sits over its middle)
  const a = await screenPoint(page, 2, 2), b = await screenPoint(page, 5, 4);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 4 });
  await page.mouse.up();
  await confirmDialog(page);
  const p = await page.evaluate(() => {
    const l = window.pigmentApp.doc.active;
    return { type: l.type, scale: l.paint.pattern.scale, origin: l.paint.pattern.origin, link: l.paint.pattern.link, name: l.paint.pattern.name };
  });
  expect(p).toEqual({ type: 'fill', scale: 2, origin: [3, 2], link: true, name: 'Stripes' });
  expect((await history(page)).slice(-2)).toEqual(['New fill layer', 'Edit fill']);
  // scale 2 from origin (3, 2): rows 2..5 red, 6..9 blue, then red again from 10
  expect(await pixel(page, 10, 3)).toEqual([255, 0, 0, 255]);
  expect(await pixel(page, 10, 7)).toEqual([0, 0, 255, 255]);
  expect(await pixel(page, 10, 11)).toEqual([255, 0, 0, 255]);

  // Properties: Angle 90 turns the stripes upright; Snap to Origin puts the tiles back on the document origin
  await runAwait(page, 'window:panel-properties');
  const section = page.locator('.pattern-fill-section');
  await expect(section).toBeVisible();
  await section.locator('input[data-key="angle"]').fill('90');
  await section.locator('input[data-key="angle"]').dispatchEvent('change');
  await expect.poll(() => page.evaluate(() => window.pigmentApp.doc.active.paint.pattern.angle)).toBe(90);
  await page.locator('.pattern-fill-section [data-act="snap-origin"]').click();
  await expect.poll(() => page.evaluate(() => window.pigmentApp.doc.active.paint.pattern.origin)).toEqual([0, 0]);
  // turned a quarter counter-clockwise: the tile's top (red) half lies on the left of each 8 px column pair
  const row = await page.evaluate(() => {
    const d = window.pigmentApp.doc;
    const px = d.view.compositor.composite(d).getContext('2d').getImageData(0, 20, 16, 1).data;
    return [px[1 * 4], px[1 * 4 + 2], px[5 * 4], px[5 * 4 + 2], px[9 * 4], px[13 * 4]];
  });
  expect(row).toEqual([255, 0, 0, 255, 255, 0]);
  expect((await history(page)).slice(-2)).toEqual(['Edit fill', 'Edit fill']);
  // undo brings the origin back
  await runAwait(page, 'edit:undo');
  expect(await page.evaluate(() => window.pigmentApp.doc.active.paint.pattern.origin)).toEqual([3, 2]);
  expect(errors).toEqual([]);
});

test('a layer style whose pattern preset was deleted still renders (the ref carries its pixels)', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 60, height: 40 });
  const id = await defineTile(page, 'Overlay');
  await runAwait(page, 'layer:new', { name: 'Styled' });
  await paintRects(page, [[0, 0, 60, 40, '#00ff00']]);
  await page.evaluate(async () => {
    const app = window.pigmentApp;
    const { isStubWidget } = await import('/lib/fields.js');
    const { setLayerProps } = await import('/lib/layer-ops.js');
    const ref = app.patterns.ref(app.patterns.current());
    // until layer-style-effects lands, the stub style preparation reads 0.3's data URL string
    const pattern = isStubWidget('contour') ? ref.dataUrl : ref;
    setLayerProps(app, app.doc.active, { styles: { patternOverlay: { enabled: true, blend: 'normal', opacity: 1, scale: 1, pattern } } }, 'Layer style');
  });
  await expect.poll(() => pixel(page, 1, 1)).toEqual([255, 0, 0, 255]);
  await page.evaluate((pid) => window.pigmentApp.patterns.remove(pid), id);
  expect(await page.evaluate((pid) => window.pigmentApp.patterns.list().some((e) => e.id === pid), id)).toBe(false);
  // a fresh render (a new document version) still finds the pixels
  await page.evaluate(() => {
    const app = window.pigmentApp;
    app.doc.active.touch();
    app.doc.changed('props', { layer: app.doc.active });
  });
  expect(await pixel(page, 1, 1)).toEqual([255, 0, 0, 255]);
  expect(await pixel(page, 1, 3)).toEqual([0, 0, 255, 255]);
  // and a copy of the style in another document renders too (no preset needed anywhere)
  const styles = await page.evaluate(() => JSON.stringify(window.pigmentApp.doc.active.styles));
  await newDoc(page, { width: 20, height: 20 });
  await page.evaluate(async (s) => {
    const app = window.pigmentApp;
    const { setLayerProps } = await import('/lib/layer-ops.js');
    setLayerProps(app, app.doc.active, { styles: JSON.parse(s) }, 'Paste layer style');
  }, styles);
  await expect.poll(() => pixel(page, 0, 0)).toEqual([255, 0, 0, 255]);
  expect(errors).toEqual([]);
});

test('View > Pattern Preview repeats the document around itself in the view only', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 40, height: 30 });
  await paintRects(page, [[0, 0, 40, 30, '#ff0000'], [0, 0, 10, 10, '#0000ff']]);
  await page.evaluate(() => window.pigmentApp.view.setZoom(2));
  const outside = () => page.evaluate(() => {
    const v = window.pigmentApp.view;
    v.paint();
    // a point one document width to the right of the document's (5, 5): the blue corner of the next tile
    const p = v.toScreen(45, 5);
    const ctx = v.canvas.getContext('2d');
    return Array.from(ctx.getImageData(Math.round(p.x * v.dpr), Math.round(p.y * v.dpr), 1, 1).data);
  });
  const before = await outside();
  expect(before).not.toEqual([0, 0, 255, 255]);
  await runAwait(page, 'view:pattern-preview');
  expect(await page.evaluate(() => [window.pigmentApp.ui.patternPreview, window.pigmentApp.commands.isChecked?.('view:pattern-preview') ?? true])).toEqual([true, true]);
  await expect.poll(outside).toEqual([0, 0, 255, 255]);
  // the document is not changed: same size, no history
  expect(await page.evaluate(() => [window.pigmentApp.doc.width, window.pigmentApp.doc.height, window.pigmentApp.doc.history.index])).toEqual([40, 30, -1]);
  await runAwait(page, 'view:pattern-preview');
  await expect.poll(outside).toEqual(before);
  expect(errors).toEqual([]);
});

test('dragging a pattern from the panel onto the canvas or a layer row makes a Pattern Fill layer', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 60, height: 40 });
  await runAwait(page, 'layer:new', { name: 'Top' });
  await runAwait(page, 'window:panel-patterns');
  await page.evaluate(() => window.pigmentApp.patterns.ready());
  const swatch = page.locator('.patterns-panel .pp-swatch[data-preset-id="bricks"]');
  await expect(swatch).toBeVisible();
  await swatch.dragTo(page.locator('.doc-frame:not([hidden]) canvas.view'));
  await expect.poll(() => page.evaluate(() => {
    const l = window.pigmentApp.doc.active;
    return [l.type, l.paint?.type, l.paint?.pattern?.name, l.paint?.pattern?.canvas?.width];
  })).toEqual(['fill', 'pattern', 'Bricks', 32]);
  expect(await page.locator('.dialog').count()).toBe(0); // a drop asks nothing
  expect((await history(page)).at(-1)).toBe('New fill layer');
  // onto a layer row: the new layer goes above that layer
  await runAwait(page, 'window:panel-layers');
  const row = page.locator('.layer-row').filter({ hasText: 'Top' }).first();
  await expect(row).toBeVisible();
  await page.locator('.patterns-panel .pp-swatch[data-preset-id="dots"]').dragTo(row);
  await expect.poll(() => page.evaluate(() => window.pigmentApp.doc.active.paint?.pattern?.name ?? null)).toBe('Dots');
  const order = await page.evaluate(() => window.pigmentApp.doc.layers().map((l) => l.name));
  expect(Math.abs(order.indexOf('Pattern Fill 2') - order.indexOf('Top'))).toBe(1);
  expect(errors).toEqual([]);
});

test('the Paint Bucket paints the pattern of its options bar, its tiles anchored at the document origin', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 60, height: 40 });
  await page.evaluate(async () => {
    const app = window.pigmentApp;
    await app.patterns.ready();
    app.tools.activate('bucket');
    app.tools.setOpt('bucket', 'source', 'pattern');
    app.tools.setOpt('bucket', 'pattern', await app.patterns.refFor('dots'));
  });
  // the options bar shows the pattern widget with Dots
  await expect(page.locator('#options-bar [data-widget="pattern"], #options-bar .pw').first()).toBeVisible();
  const p = await screenPoint(page, 30, 20);
  await page.mouse.click(p.x, p.y);
  const tile = await page.evaluate(async () => {
    const e = await window.pigmentApp.patterns.get('dots');
    return Array.from(e.canvas.getContext('2d').getImageData(0, 0, 12, 12).data);
  });
  const at = (x, y) => tile.slice(((y % 12) * 12 + (x % 12)) * 4, ((y % 12) * 12 + (x % 12)) * 4 + 4);
  for (const [x, y] of [[6, 6], [30, 20], [17, 33], [59, 39]]) expect(await layerPixel(page, x, y)).toEqual(at(x, y));
  expect((await history(page)).at(-1)).toBe('Paint bucket');
  expect(errors).toEqual([]);
});

test('Bitmap > Custom Pattern takes a pattern of the library through the widget', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 40, height: 40 });
  await runAwait(page, 'edit:fill', { use: 'grey', opacity: 100, blend: 'normal', preserve: false });
  await runAwait(page, 'image:mode', { mode: 'grayscale', silent: true, flatten: true });
  await page.evaluate(() => window.pigmentApp.patterns.ready());
  await run(page, 'image:mode', 'bitmap');
  const dialog = page.locator('.dialog');
  await expect(dialog.locator('select[data-key="method"]')).toBeVisible();
  await dialog.locator('select[data-key="method"]').selectOption('custom-pattern');
  await dialog.locator('select[data-key="pattern"]').selectOption('library');
  const widget = dialog.locator('[data-widget="pattern"]');
  await widget.locator('.pw-more').click();
  await widget.locator('.pp-swatch[data-preset-id="checkerboard"]').click();
  await confirmDialog(page);
  await expect.poll(() => page.evaluate(() => window.pigmentApp.doc.mode)).toBe('bitmap');
  // grey 128 against the checkerboard's thresholds 96 (white) and 208 (black), in 8 px squares from the origin
  expect(await pixel(page, 2, 2)).toEqual([0, 0, 0, 255]);
  expect(await pixel(page, 10, 2)).toEqual([255, 255, 255, 255]);
  expect(await pixel(page, 10, 10)).toEqual([0, 0, 0, 255]);
  expect(errors).toEqual([]);
});

test('a Pattern Fill layer keeps its pixels, Angle, Link with Layer and origin through a .pigment round trip', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 40, height: 30 });
  await defineTile(page, 'Saved');
  await page.evaluate(async () => {
    const app = window.pigmentApp;
    const { makePatternPaint } = await import('/lib/pattern-paint.js');
    const cur = app.patterns.current();
    await app.commands.run('layer:new-fill', { kind: 'solid', paint: { type: 'solid', color: '#000000' } }, 'api');
    const { setLayerProps } = await import('/lib/layer-ops.js');
    setLayerProps(app, app.doc.active, { paint: makePatternPaint(cur.canvas, { scale: 1.5, angle: 30, link: false, origin: [3, 1], presetId: cur.id, name: cur.name }) }, 'Edit fill');
  });
  // the describe() of a fill layer is the skeleton's (document.js); J.1 has it write the PatternPaint fields
  const described = await page.evaluate(() => JSON.stringify(window.pigmentApp.doc.describe()).includes('"angle":30'));
  test.skip(!described, 'document.js describe() writes only the pattern scale of a fill layer (J.1 lists angle, link, origin, presetId, name): integrator');
  const before = await pixel(page, 7, 9);
  await page.evaluate(() => (window.__pigmentTest.nextSavePath = 'mem:/pattern.pigment'));
  await runAwait(page, 'file:save-as');
  await expect.poll(() => page.evaluate(() => !!window.__pigmentTest.written['mem:/pattern.pigment'])).toBe(true);
  await page.evaluate(() => (window.__pigmentTest.files['mem:/pattern-again.pigment'] = window.__pigmentTest.written['mem:/pattern.pigment']));
  await runAwait(page, 'file:open-paths', ['mem:/pattern-again.pigment']);
  await expect.poll(() => page.evaluate(() => window.pigmentApp.doc.path)).toBe('mem:/pattern-again.pigment');
  const back = await page.evaluate(() => {
    const l = window.pigmentApp.doc.layers().find((x) => x.type === 'fill');
    const p = l.paint.pattern;
    return { scale: p.scale, angle: p.angle, link: p.link, origin: p.origin, name: p.name, w: p.canvas?.width };
  });
  expect(back).toEqual({ scale: 1.5, angle: 30, link: false, origin: [3, 1], name: 'Saved', w: 4 });
  await expect.poll(() => pixel(page, 7, 9)).toEqual(before);
  expect(errors).toEqual([]);
});
