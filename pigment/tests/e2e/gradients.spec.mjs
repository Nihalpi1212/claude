// gradients (0.4 package 9, port 8809): the gradient widget, picker and presets, the Gradient Editor, New Fill Layer >
// Gradient, the Properties fill section, live gradients of the Gradient tool, the Gradients panel and its drags, the
// per-pixel renderer of the interpolation methods and noise.
import { test, expect } from '@playwright/test';
import { openApp, newDoc, run, runAwait, drag, confirmDialog, screenPoint } from './helpers.mjs';

const history = (page) => page.evaluate(() => window.pigmentApp.doc.history.entries.slice(0, window.pigmentApp.doc.history.index + 1).map((e) => e.label));

test('the gradient widget, picker and Gradient Editor in a dialog form', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 120, height: 80 });
  expect(await page.evaluate(async () => (await import('/lib/fields.js')).isStubWidget('gradient'))).toBe(false);
  await page.evaluate(() => {
    const app = window.pigmentApp;
    app.setColors({ foreground: '#ff0000', background: '#0000ff' });
    window.__form = import('/lib/form.js').then(({ formDialog }) => formDialog(app, {
      title: 'Widgets',
      fields: [
        { key: 'g', label: 'Gradient', type: 'gradient', value: { kind: 'radial', angle: 30, stops: [{ pos: 0, color: '#00ff00' }, { pos: 1, color: '#000000' }] } },
        { key: 'm', label: 'Map', type: 'gradient', placement: false, flags: ['reverse', 'dither'], method: true, value: null },
      ],
    }));
  });
  const dialog = page.locator('.dialog');
  const g = dialog.locator('[data-widget="gradient"][data-key="g"]');
  // placement fields: style, angle, scale, reverse, dither, align
  await expect(g.locator('select[data-key="kind"]')).toHaveValue('radial');
  await expect(g.locator('input[data-key="angle"]')).toHaveValue('30');
  await expect(g.locator('input[data-key="scale"]')).toHaveValue('100');
  for (const k of ['reverse', 'dither', 'align']) await expect(g.locator(`input[data-key="${k}"]`)).toHaveCount(1);
  const m = dialog.locator('[data-widget="gradient"][data-key="m"]');
  await expect(m.locator('select[data-key="kind"]')).toHaveCount(0);
  await expect(m.locator('input[data-key="reverse"]')).toHaveCount(1);
  await expect(m.locator('select[data-key="interpolation"]')).toHaveCount(1);
  await g.locator('input[data-key="scale"]').fill('150');
  await g.locator('input[data-key="scale"]').dispatchEvent('change');
  await g.locator('select[data-key="kind"]').selectOption('diamond');

  // the picker opens inline in a dialog; picking "Foreground to background" resolves the references
  await m.locator('.gw-more').click();
  await expect(m.locator('.gw-inline-picker .gp-group-head')).toHaveCount(10);
  await m.locator('.gp-swatch[data-preset-id="foreground-to-background"]').click();
  await m.locator('input[data-key="reverse"]').check();

  // the Gradient Editor opens on top of the dialog: add a colour stop on the stop row, drag it, set its location
  await g.locator('.gw-bar').click();
  const ed = page.locator('.gradient-editor');
  await expect(ed).toHaveCount(1);
  await expect(ed.locator('.ge-color-row .ge-stop')).toHaveCount(2);
  const row = await ed.locator('.ge-color-row').boundingBox();
  await page.mouse.click(row.x + row.width * 0.35, row.y + row.height / 2); // (the middle holds the midpoint diamond)
  await expect(ed.locator('.ge-color-row .ge-stop')).toHaveCount(3);
  await ed.locator('input[data-key="stop-color-location"]').fill('25');
  await ed.locator('input[data-key="stop-color-location"]').dispatchEvent('change');
  // an opacity stop, then a drag away from its row deletes it again
  const orow = await ed.locator('.ge-opacity-row').boundingBox();
  await page.mouse.click(orow.x + orow.width * 0.75, orow.y + orow.height / 2);
  await expect(ed.locator('.ge-opacity-row .ge-stop')).toHaveCount(3);
  await ed.locator('input[data-key="stop-opacity"]').fill('40');
  await ed.locator('input[data-key="stop-opacity"]').dispatchEvent('change');
  const ostop = await ed.locator('.ge-opacity-row .ge-stop[data-index="1"]').boundingBox();
  await page.mouse.move(ostop.x + 6, ostop.y + 8);
  await page.mouse.down();
  await page.mouse.move(ostop.x + 6, ostop.y - 80, { steps: 5 });
  await page.mouse.up();
  await expect(ed.locator('.ge-opacity-row .ge-stop')).toHaveCount(2);
  await ed.locator('select[data-key="interpolation"]').selectOption('stripes');
  await page.locator('.gradient-editor-dialog .dialog-buttons .btn.primary').click();
  await expect(ed).toHaveCount(0);

  await page.locator('.dialog .dialog-buttons .btn.primary').click();
  const v = await page.evaluate(() => window.__form);
  expect(v.g).toMatchObject({ gradientVersion: 2, kind: 'diamond', angle: 30, scale: 1.5, interpolation: 'stripes' });
  expect(v.g.stops.map((s) => s.pos)).toEqual([0, 0.25, 1]);
  expect(v.g.stops.every((s) => typeof s.color === 'string')).toBe(true);
  // placement: false reports the def with Reverse and Dither but no style or angle; references resolved
  expect(v.m).toMatchObject({ gradientVersion: 2, reverse: true, interpolation: 'classic' });
  expect(v.m.kind).toBeUndefined();
  expect(v.m.stops.map((s) => s.color)).toEqual(['#ff0000', '#0000ff']);
  expect(errors).toEqual([]);
});

test('New Fill Layer > Gradient: preset, method and placement through the Gradient Fill dialog, one history entry', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 200, height: 100 });
  const before = (await history(page)).length;
  await run(page, 'layer:new-fill', 'gradient');
  const dialog = page.locator('.dialog');
  await expect(dialog).toContainText('Gradient Fill');
  await dialog.locator('[data-widget="gradient"] .gw-more').click();
  await dialog.locator('.gp-swatch[data-preset-id="black-to-white"]').click();
  await dialog.locator('[data-widget="gradient"] select[data-key="interpolation"]').selectOption('linear');
  await dialog.locator('select[data-key="kind"]').first().selectOption('linear');
  await dialog.locator('input[data-key="angle"]').fill('90');
  await dialog.locator('input[data-key="angle"]').dispatchEvent('change');
  await confirmDialog(page);
  const r = await page.evaluate(() => {
    const l = window.pigmentApp.doc.active;
    return { type: l.type, g: l.paint.gradient };
  });
  expect(r.type).toBe('fill');
  expect(r.g).toMatchObject({ gradientVersion: 2, interpolation: 'linear', kind: 'linear' });
  // angle 90: bottom (black) to top (white) through the document's centre
  expect(r.g.from.map((v) => Math.round(v) + 0)).toEqual([100, 100]);
  expect(r.g.to.map((v) => Math.round(v) + 0)).toEqual([100, 0]);
  expect((await history(page)).slice(before)).toEqual(['New fill layer', 'Edit gradient fill']);
  // linear light: the middle row is sRGB 188, not 128
  const mid = await page.evaluate(() => {
    const d = window.pigmentApp.doc;
    return Array.from(d.view.compositor.composite(d).getContext('2d').getImageData(50, 50, 1, 1).data);
  });
  expect(Math.abs(mid[0] - 188)).toBeLessThanOrEqual(2);
  expect(errors).toEqual([]);
});

test('per-pixel methods and noise render like the reference sampler; classic stays a Canvas gradient', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 101, height: 20 });
  const r = await page.evaluate(async () => {
    const app = window.pigmentApp;
    const d = app.doc;
    const { FillLayer } = await import('/lib/document.js');
    const { sampleGradient, normalizeGradient } = await import('/shared/pixels/gradient-model.js');
    const out = {};
    const defs = {
      perceptual: { gradientVersion: 2, interpolation: 'perceptual', stops: [{ pos: 0, color: '#ff0000' }, { pos: 0.4, mid: 0.3, color: '#00ff00' }, { pos: 1, color: '#0000ff' }] },
      smooth: { gradientVersion: 2, interpolation: 'smooth', stops: [{ pos: 0, color: '#000000' }, { pos: 0.3, color: '#808080' }, { pos: 1, color: '#ffffff' }] },
      stripes: { gradientVersion: 2, interpolation: 'stripes', stops: [{ pos: 0, color: '#ff0000' }, { pos: 0.5, color: '#00ff00' }, { pos: 1, color: '#0000ff' }] },
      noise: { gradientVersion: 2, type: 'noise', noise: { roughness: 0.4, model: 'rgb', seed: 5 } },
    };
    for (const [name, def] of Object.entries(defs)) {
      const layer = new FillLayer({ name, paint: { type: 'gradient', gradient: { ...normalizeGradient(def), kind: 'linear', from: [0.5, 0], to: [100.5, 0] } }, docWidth: d.width, docHeight: d.height });
      const c = layer.render().canvas.getContext('2d').getImageData(0, 10, 101, 1).data;
      let worst = 0;
      for (let x = 0; x < 101; x++) {
        const t = x / 100;
        const ref = sampleGradient(def, t).map((v, i) => Math.round(i === 3 ? v * 255 : v));
        // a hard edge may land on either side of a pixel centre
        const near = [ref, sampleGradient(def, Math.min(1, t + 0.002)).map((v, i) => Math.round(i === 3 ? v * 255 : v)), sampleGradient(def, Math.max(0, t - 0.002)).map((v, i) => Math.round(i === 3 ? v * 255 : v))];
        const got = Array.from(c.slice(x * 4, x * 4 + 4));
        worst = Math.max(worst, Math.min(...near.map((n) => Math.max(...n.map((v, i) => Math.abs(v - got[i]))))));
      }
      out[name] = worst;
    }
    // a classic def is still drawn by a Canvas gradient: identical to 0.3's
    const classic = new FillLayer({ paint: { type: 'gradient', gradient: { kind: 'linear', stops: [{ pos: 0, color: '#ff0000' }, { pos: 1, color: '#0000ff' }], from: [0, 0], to: [101, 0] } }, docWidth: 101, docHeight: 20 });
    const a = classic.render().canvas.getContext('2d').getImageData(0, 5, 101, 1).data;
    const c = document.createElement('canvas');
    c.width = 101;
    c.height = 20;
    const ctx = c.getContext('2d');
    const grad = ctx.createLinearGradient(0, 0, 101, 0);
    grad.addColorStop(0, '#ff0000');
    grad.addColorStop(1, '#0000ff');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 101, 20);
    const b = ctx.getImageData(0, 5, 101, 1).data;
    out.classicSame = a.every((v, i) => v === b[i]);
    return out;
  });
  expect(r).toEqual({ perceptual: expect.any(Number), smooth: expect.any(Number), stripes: expect.any(Number), noise: expect.any(Number), classicSame: true });
  for (const k of ['perceptual', 'smooth', 'stripes', 'noise']) expect(r[k], k).toBeLessThanOrEqual(1);
  expect(errors).toEqual([]);
});

test('live gradients: Gradient mode makes a Gradient Fill layer and edits it on the canvas', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 300, height: 200 });
  await page.evaluate(() => {
    const app = window.pigmentApp;
    app.setColors({ foreground: '#ff0000', background: '#0000ff' });
    app.tools.activate('gradient');
    app.tools.setOpt('gradient', 'mode', 'gradient');
  });
  // Mode and Opacity are Classic options
  await expect(page.locator('.opt[data-key="blend"]')).toHaveCount(0);
  await expect(page.locator('.opt[data-key="gradient"] .gw-bar')).toHaveCount(1);
  const before = (await page.evaluate(() => window.pigmentApp.doc.layers().length));
  await drag(page, [20, 100], [280, 100]);
  const made = await page.evaluate(() => {
    const d = window.pigmentApp.doc;
    const l = d.active;
    return { n: d.layers().length, type: l.type, from: l.paint.gradient.from.map(Math.round), to: l.paint.gradient.to.map(Math.round), stops: l.paint.gradient.stops.map((s) => s.color) };
  });
  expect(made).toEqual({ n: before + 1, type: 'fill', from: [20, 100], to: [280, 100], stops: ['#ff0000', '#0000ff'] });
  const h0 = (await history(page)).length;
  // drag the end point
  await drag(page, [280, 100], [200, 40]);
  expect(await page.evaluate(() => window.pigmentApp.doc.active.paint.gradient.to.map(Math.round))).toEqual([200, 40]);
  // drag the line: both ends move
  await drag(page, [110, 70], [120, 80]);
  expect(await page.evaluate(() => [window.pigmentApp.doc.active.paint.gradient.from.map(Math.round), window.pigmentApp.doc.active.paint.gradient.to.map(Math.round)])).toEqual([[30, 110], [210, 50]]);
  // click the line: a colour stop in the colour the gradient has there
  const at = await screenPoint(page, 120, 80);
  await page.mouse.click(at.x, at.y);
  const stops = await page.evaluate(() => window.pigmentApp.doc.active.paint.gradient.stops.map((s) => [Math.round(s.pos * 100), s.color]));
  expect(stops.length).toBe(3);
  expect(stops[1][0]).toBe(50);
  // Delete removes the selected stop
  await page.keyboard.press('Delete');
  expect(await page.evaluate(() => window.pigmentApp.doc.active.paint.gradient.stops.length)).toBe(2);
  expect((await history(page)).slice(h0)).toEqual(['Edit gradient', 'Edit gradient', 'Edit gradient', 'Delete gradient stop']);
  await runAwait(page, 'edit:undo');
  expect(await page.evaluate(() => window.pigmentApp.doc.active.paint.gradient.stops.length)).toBe(3);
  // a new drag with the fill layer active redraws its gradient (no new layer)
  await drag(page, [150, 10], [150, 190]);
  expect(await page.evaluate(() => [window.pigmentApp.doc.layers().length, window.pigmentApp.doc.active.paint.gradient.from.map(Math.round)])).toEqual([before + 1, [150, 10]]);
  // Classic mode paints pixels as in 0.3
  await page.evaluate(() => {
    const app = window.pigmentApp;
    app.doc.setActive(app.doc.layers()[0]);
    app.tools.setOpt('gradient', 'mode', 'classic');
  });
  await expect(page.locator('.opt[data-key="blend"]')).toHaveCount(1);
  await drag(page, [0, 100], [299, 100]);
  expect(await page.evaluate(() => [window.pigmentApp.doc.layers().length, window.pigmentApp.doc.active.type])).toEqual([before + 1, 'raster']);
  expect(errors).toEqual([]);
});

test('the Gradient tool keeps 0.3\'s preset index as a preset id, keeps colour references and uses the picked preset', async ({ page }) => {
  const errors = await openApp(page);
  await page.addInitScript(() => {
    try {
      localStorage.setItem('pigment.settings', JSON.stringify({ tools: { gradient: { preset: '3' } } }));
    } catch {}
  });
  await page.reload();
  await page.waitForSelector('body[data-ready]');
  await newDoc(page, { width: 100, height: 40 });
  const r = await page.evaluate(() => {
    const t = window.pigmentApp.tools.tools.get('gradient');
    return { id: t.presetId(), stops: t.drawDef().stops.length };
  });
  expect(r).toEqual({ id: 'spectrum', stops: 7 });
  // picking a preset with references in the options bar keeps them; drawing resolves them with the current colours
  await page.evaluate(() => {
    window.pigmentApp.tools.activate('gradient');
    window.pigmentApp.setColors({ foreground: '#00ff00', background: '#000000' });
  });
  await page.locator('.opt[data-key="gradient"] .gw-more').click();
  await page.locator('.gw-pop-picker .gp-swatch[data-preset-id="foreground-to-transparent"]').click();
  const opt = await page.evaluate(() => {
    const t = window.pigmentApp.tools.tools.get('gradient');
    return { preset: t.opt('preset'), refs: t.opt('gradient').stops.map((s) => s.color), drawn: t.drawDef().stops.map((s) => s.color), alpha: t.drawDef().opacityStops.map((s) => s.opacity) };
  });
  expect(opt).toEqual({ preset: 'foreground-to-transparent', refs: [{ ref: 'fg' }, { ref: 'fg' }], drawn: ['#00ff00', '#00ff00'], alpha: [1, 0] });
  expect(errors).toEqual([]);
});

test('the Gradients panel: groups, apply, presets saved and reset, drag onto the canvas and a layer row', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 160, height: 100 });
  await page.evaluate(() => window.pigmentApp.panels.show('gradients', { reveal: true }));
  expect(await page.evaluate(() => window.pigmentApp.stubbed.includes('window:panel-gradients'))).toBe(false);
  const panel = page.locator('.panel[data-panel="gradients"]');
  await expect(panel.locator('.gp-group-head')).toHaveCount(10);
  // a click without a Gradient Fill layer makes it the tool's gradient
  await panel.locator('.gp-swatch[data-preset-id="sky"]').click();
  expect(await page.evaluate(() => window.pigmentApp.tools.opt('gradient', 'preset'))).toBe('sky');
  // collapsing a group is remembered
  await panel.locator('.gp-group[data-group="blues"] .gp-group-head').click();
  await expect(panel.locator('.gp-group[data-group="blues"] .gp-swatch')).toHaveCount(0);
  expect(await page.evaluate(() => window.pigmentApp.settings.gradients.collapsed)).toEqual({ blues: true });
  await panel.locator('.gp-group[data-group="blues"] .gp-group-head').click();

  // drag a swatch onto the canvas: a Gradient Fill layer above the active one
  const dropped = await page.evaluate(async () => {
    const app = window.pigmentApp;
    const sw = document.querySelector('.panel[data-panel="gradients"] .gp-swatch[data-preset-id="ember"]');
    const dt = new DataTransfer();
    sw.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true }));
    const r = app.view.canvas.getBoundingClientRect();
    const s = app.view.toScreen(80, 50);
    const opts = { dataTransfer: dt, bubbles: true, cancelable: true, clientX: r.left + s.x, clientY: r.top + s.y };
    const over = new DragEvent('dragover', opts);
    app.view.canvas.dispatchEvent(over);
    app.view.canvas.dispatchEvent(new DragEvent('drop', opts));
    await new Promise((res) => setTimeout(res, 100));
    const l = app.doc.active;
    return { accepted: over.defaultPrevented, type: l.type, colors: l.paint.gradient.stops.map((s) => s.color), from: l.paint.gradient.from };
  });
  expect(dropped).toEqual({ accepted: true, type: 'fill', colors: ['#3a0000', '#ff3b1f'], from: [0, 50] });
  // with the Gradient Fill layer active, a click applies the preset to it (placement kept), one history entry
  const h0 = (await history(page)).length;
  await panel.locator('.gp-swatch[data-preset-id="black-to-white"]').click();
  expect(await page.evaluate(() => [window.pigmentApp.doc.active.paint.gradient.stops.map((s) => s.color), window.pigmentApp.doc.active.paint.gradient.from])).toEqual([['#000000', '#ffffff'], [0, 50]]);
  expect((await history(page)).slice(h0)).toEqual(['Apply gradient preset']);
  // drag onto a layer row: the new layer goes above that layer
  const onRow = await page.evaluate(async () => {
    const app = window.pigmentApp;
    app.panels.show('layers', { reveal: true });
    await new Promise((res) => requestAnimationFrame(res));
    const bg = app.doc.layers()[0];
    const sw = document.querySelector('.panel[data-panel="gradients"] .gp-swatch[data-preset-id="mint"]');
    const dt = new DataTransfer();
    sw.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true }));
    const row = document.querySelector(`.layer-row[data-id="${bg.id}"]`);
    row.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
    row.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    await new Promise((res) => setTimeout(res, 100));
    const layers = app.doc.layers();
    return { index: layers.indexOf(app.doc.active), n: layers.length, first: app.doc.active.paint.gradient.stops[0].color };
  });
  expect(onRow).toEqual({ index: 1, n: 3, first: '#00a67e' });

  // New gradient from the active fill layer, into the selected gradient's group; Reset brings back the built-ins only
  await page.evaluate(() => window.pigmentApp.panels.show('gradients', { reveal: true }));
  await panel.locator('[data-act="new"]').click();
  await page.locator('.dialog input').fill('My Mint');
  await page.locator('.dialog .dialog-buttons .btn.primary').click();
  await expect(panel.locator('.gp-swatch[title="My Mint"]')).toHaveCount(1);
  const saved = await page.evaluate(async () => {
    const app = window.pigmentApp;
    await app.presets.flush();
    const p = app.presets.list('gradients').find((x) => x.name === 'My Mint');
    return { group: p.group, first: p.data.stops[0].color };
  });
  expect(saved).toEqual({ group: 'basics', first: '#00a67e' }); // the group of the selected gradient (Black to White)
  // rename through the context menu
  await panel.locator('.gp-swatch[title="My Mint"]').click({ button: 'right' });
  await page.locator('.popover-item', { hasText: 'Rename Gradient' }).click();
  await page.locator('.dialog input').fill('Mint 2');
  await page.locator('.dialog .dialog-buttons .btn.primary').click();
  await expect(panel.locator('.gp-swatch[title="Mint 2"]')).toHaveCount(1);
  // Export All, then Reset, then Import brings the user preset back
  await page.evaluate(() => (window.__pigmentTest.nextSavePath = 'mem:/g.pigment-presets'));
  await panel.locator('[data-act="menu"]').click();
  await page.locator('.popover-item', { hasText: 'Export All Gradients' }).click();
  await expect.poll(() => page.evaluate(() => !!window.__pigmentTest.written['mem:/g.pigment-presets'])).toBe(true);
  await panel.locator('[data-act="menu"]').click();
  await page.locator('.popover-item', { hasText: 'Reset Gradients' }).click();
  await page.locator('.dialog .dialog-buttons .btn.primary').click();
  await expect(panel.locator('.gp-swatch[title="Mint 2"]')).toHaveCount(0);
  await page.evaluate(() => {
    window.__pigmentTest.files['mem:/g.pigment-presets'] = window.__pigmentTest.written['mem:/g.pigment-presets'];
    window.__pigmentTest.nextOpenFiles = ['mem:/g.pigment-presets'];
  });
  await panel.locator('[data-act="menu"]').click();
  await page.locator('.popover-item', { hasText: 'Import Gradients' }).click();
  await expect(panel.locator('.gp-swatch[title="Mint 2"]')).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('the Properties fill section edits the gradient fill: widget preview, style and angle, undo', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 120, height: 60 });
  await page.evaluate(async () => {
    const app = window.pigmentApp;
    const preset = app.presets.get('gradients', 'black-to-white');
    await app.commands.run('layer:new-fill', { kind: 'gradient', paint: { type: 'gradient', gradient: { ...preset.data, kind: 'linear', from: [0, 30], to: [120, 30] } } }, 'api');
    app.panels.show('properties', { reveal: true });
  });
  const sec = page.locator('.gradient-fill-section');
  await expect(sec).toHaveCount(1);
  const h0 = (await history(page)).length;
  await sec.locator('select[data-key="kind"]').selectOption('radial');
  await sec.locator('input[data-key="angle"]').fill('45');
  await sec.locator('input[data-key="angle"]').dispatchEvent('change');
  const g = await page.evaluate(() => window.pigmentApp.doc.active.paint.gradient);
  expect(g.kind).toBe('radial');
  expect(Math.round((Math.atan2(-(g.to[1] - g.from[1]), g.to[0] - g.from[0]) * 180) / Math.PI)).toBe(45);
  expect((await history(page)).slice(h0)).toEqual(['Edit gradient fill', 'Edit gradient fill']);
  // the editor previews on the canvas; Cancel puts the gradient back without a history entry
  await sec.locator('.gw-bar').click();
  await page.locator('.gradient-editor select[data-key="type"]').selectOption('noise');
  await expect.poll(() => page.evaluate(() => window.pigmentApp.doc.active.paint.gradient.type)).toBe('noise');
  await page.locator('.gradient-editor-dialog .dialog-buttons .btn', { hasText: 'Cancel' }).click();
  await expect.poll(() => page.evaluate(() => window.pigmentApp.doc.active.paint.gradient.type)).toBe('solid');
  expect((await history(page)).length).toBe(h0 + 2);
  await runAwait(page, 'edit:undo');
  expect(await page.evaluate(() => window.pigmentApp.doc.active.paint.gradient.kind)).toBe('radial');
  await runAwait(page, 'edit:undo');
  expect(await page.evaluate(() => window.pigmentApp.doc.active.paint.gradient.kind)).toBe('linear');
  expect(errors).toEqual([]);
});

test('paint placement relative to the box: a shape gradient keeps its place when the render canvas grows', async ({ page }) => {
  const errors = await openApp(page);
  const r = await page.evaluate(async () => {
    const { paintStyle } = await import('/lib/paint.js');
    const { sampleGradient, gradientT, normalizeGradient } = await import('/shared/pixels/gradient-model.js');
    // the path bounds 60 x 40 at document (100, 50); the render canvas is padded by the stroke
    const bounds = { x: 100, y: 50, width: 60, height: 40 };
    const out = {};
    for (const interpolation of ['classic', 'perceptual']) {
      for (const kind of ['linear', 'radial', 'reflected', 'diamond', 'angle']) {
        const gradient = { ...normalizeGradient({ gradientVersion: 2, interpolation, smoothness: 0, stops: [{ pos: 0, color: '#ff0000' }, { pos: 1, color: '#0000ff' }] }), kind, angle: 30, scale: 0.8, offset: [10, 0] };
        const render = (pad) => {
          const c = document.createElement('canvas');
          c.width = bounds.width + 2 * pad;
          c.height = bounds.height + 2 * pad;
          const ctx = c.getContext('2d');
          ctx.fillStyle = paintStyle(ctx, { type: 'gradient', gradient }, { x: pad, y: pad, width: bounds.width, height: bounds.height }, { origin: [bounds.x - pad, bounds.y - pad] });
          ctx.fillRect(0, 0, c.width, c.height);
          const d = ctx.getImageData(0, 0, c.width, c.height).data;
          return (X, Y) => Array.from(d.slice(((Y - bounds.y + pad) * c.width + (X - bounds.x + pad)) * 4, ((Y - bounds.y + pad) * c.width + (X - bounds.x + pad)) * 4 + 4));
        };
        const thin = render(2), wide = render(14);
        let moved = 0, off = 0;
        for (let Y = bounds.y + 1; Y < bounds.y + bounds.height; Y += 6) {
          for (let X = bounds.x + 1; X < bounds.x + bounds.width; X += 6) {
            const a = thin(X, Y), b = wide(X, Y);
            moved = Math.max(moved, ...a.map((v, i) => Math.abs(v - b[i])));
            // against the reference sampler at the pixel centre, measured in the box (document space)
            const t = Math.min(1, Math.max(0, gradientT(gradient, X + 0.5 - bounds.x, Y + 0.5 - bounds.y, { x: 0, y: 0, width: bounds.width, height: bounds.height })));
            const ref = sampleGradient(gradient, t).map((v, i) => Math.round(i === 3 ? v * 255 : v));
            off = Math.max(off, ...a.map((v, i) => Math.abs(v - ref[i])));
          }
        }
        out[`${interpolation} ${kind}`] = [moved, off];
      }
    }
    return out;
  });
  for (const [k, [moved, off]] of Object.entries(r)) {
    expect(moved, `${k} moved`).toBeLessThanOrEqual(1);
    expect(off, `${k} against the sampler`).toBeLessThanOrEqual(3);
  }
  expect(errors).toEqual([]);
});
