// presets-panels (ARCHITECTURE.md "0.5 features", package 9; port 8859): the Styles, Shapes and Tool Presets panels,
// the tool preset picker of the options bar, Reset Tool / Reset All Tools, the Layer Style dialog's Styles page, New
// Style and Make Default, Define Custom Shape and the Custom Shape picker. The five paths (rule 13): undo and redo,
// .pigment and PSD, action playback (both commands replay with their data), 16-bit and Grayscale documents.
import { test, expect } from '@playwright/test';
import { openApp, newDoc, run, runAwait, pixel, drag } from './helpers.mjs';

/** window.__pp: the package's modules, a filled layer, a canvas, an in-app drop. */
async function helpers(page) {
  await page.evaluate(async () => {
    const app = window.pigmentApp;
    const TP = await import('/lib/tool-presets.js');
    const UI = await import('/lib/presets-panels-ui.js');
    const M = await import('/lib/presets-panels-model.js');
    const io = await import('/lib/io.js');
    const { RasterLayer, createCanvas } = await import('/lib/document.js');
    const { structural } = await import('/lib/layer-ops.js');
    window.__pp = {
      TP, UI, M, io,
      async ready(...kinds) {
        for (const k of kinds) await app.presets.ready(k);
      },
      canvas(w, h, color) {
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        const x = c.getContext('2d');
        x.fillStyle = color;
        x.fillRect(0, 0, w, h);
        return c;
      },
      /** A raster layer filled with `color` at the rect, active; one history entry. */
      box(name, [x, y, w, h], color = '#3366cc') {
        const c = createCanvas(w, h);
        const g = c.getContext('2d');
        g.fillStyle = color;
        g.fillRect(0, 0, w, h);
        const layer = new RasterLayer({ name, canvas: c, x, y });
        structural(app, 'Add', () => {
          app.doc.add(layer);
          app.doc.setActive(layer);
        });
        return layer;
      },
      /** An in-app drag ended on `target` (an element): the DataTransfer carries `data` under `mime`. */
      drop(target, mime, data, at = null) {
        const dt = new DataTransfer();
        dt.setData(mime, data);
        const r = target.getBoundingClientRect();
        const opts = { bubbles: true, cancelable: true, dataTransfer: dt, clientX: at ? at.x : r.left + r.width / 2, clientY: at ? at.y : r.top + r.height / 2 };
        target.dispatchEvent(new DragEvent('dragover', opts));
        target.dispatchEvent(new DragEvent('drop', opts));
      },
      entry: () => app.doc.history.entries[app.doc.history.index]?.label ?? null,
      /** Alpha of a layer's own pixels at document (x, y) (a shape layer through its render). */
      alphaAt(layer, x, y) {
        const src = layer.type === 'raster' ? { canvas: layer.canvas, x: layer.x, y: layer.y } : layer.render();
        const px = x - src.x, py = y - src.y;
        if (px < 0 || py < 0 || px >= src.canvas.width || py >= src.canvas.height) return 0;
        return src.canvas.getContext('2d').getImageData(px, py, 1, 1).data[3];
      },
      toasts: () => [...document.querySelectorAll('#toasts .toast')].map((t) => t.textContent),
    };
  });
}

test('the commands land: no stub left, panels in the Window menu, the picker in the title slot', async ({ page }) => {
  const errors = await openApp(page);
  const r = await page.evaluate(() => {
    const app = window.pigmentApp;
    const ids = ['window:panel-styles', 'window:panel-shapes', 'window:panel-tool-presets', 'edit:define-custom-shape', 'tool:preset', 'tool:reset', 'tool:reset-all', 'layer:style-preset'];
    const def = (id) => app.commands.commands.get(id);
    return {
      stubbed: ids.filter((id) => app.stubbed.includes(id)),
      record: ['tool:preset', 'tool:reset', 'tool:reset-all'].map((id) => def(id)?.record),
      title: document.querySelector('#options-bar > :first-child')?.className,
    };
  });
  expect(r.stubbed).toEqual([]);
  expect(r.record).toEqual([true, false, false]);
  expect(r.title).toBe('options-title pset-tool-picker');
  for (const [cmd, panel] of [['window:panel-styles', 'styles'], ['window:panel-shapes', 'shapes'], ['window:panel-tool-presets', 'tool-presets']]) {
    await runAwait(page, cmd);
    await expect(page.locator(`.panel[data-panel="${panel}"]`)).toBeVisible();
  }
  await expect(page.locator('[data-panel="styles"] .pset-group[data-group="basics"] .pset-item')).toHaveCount(6);
  expect(errors).toEqual([]);
});

test('Styles panel: click applies (one Apply Style entry, undo and redo), Shift-click adds, drops on a row and the canvas', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 200, height: 150 });
  await helpers(page);
  await page.evaluate(() => {
    window.__pp.box('Under', [10, 10, 60, 60], '#00aa00');
    window.__pp.box('Over', [100, 60, 60, 60], '#3366cc');
  });
  await runAwait(page, 'window:panel-styles');
  const item = (id) => page.locator(`[data-panel="styles"] .pset-item[data-id="${id}"]`);
  await item('basic-stroke').click();
  const st = () => page.evaluate(() => {
    const d = window.pigmentApp.doc;
    return { styles: d.active.styles, entry: window.__pp.entry(), index: d.history.index };
  });
  const a = await st();
  expect(a.entry).toBe('Apply Style');
  expect(a.styles).toEqual({ stroke: { enabled: true, size: 3, position: 'outside', blend: 'normal', opacity: 1, color: '#000000' } });
  // the stroke draws: black 2 px outside the layer, which was white there
  expect((await pixel(page, 98, 90)).slice(0, 3)).toEqual([0, 0, 0]);
  // a click replaces; Shift-click adds the effects to the layer's
  await item('basic-drop-shadow').click();
  expect(Object.keys((await st()).styles)).toEqual(['dropShadow']);
  await item('basic-stroke').click({ modifiers: ['Shift'] });
  const b = await st();
  expect(Object.keys(b.styles).sort()).toEqual(['dropShadow', 'stroke']);
  expect(b.index - a.index).toBe(2);
  await runAwait(page, 'edit:undo');
  expect(Object.keys((await st()).styles)).toEqual(['dropShadow']);
  await runAwait(page, 'edit:redo');
  expect(Object.keys((await st()).styles).sort()).toEqual(['dropShadow', 'stroke']);
  // dropped on a layer row: that layer gets the style
  await runAwait(page, 'window:panel-layers');
  await page.evaluate(() => {
    const row = [...document.querySelectorAll('[data-panel="layers"] li')].find((li) => li.textContent.includes('Under'));
    window.__pp.drop(row, 'application/x-pigment-style', JSON.stringify({ id: 'basic-color-overlay' }));
  });
  await expect.poll(() => page.evaluate(() => window.pigmentApp.doc.active.name)).toBe('Under');
  expect(await page.evaluate(() => Object.keys(window.pigmentApp.doc.active.styles ?? {}))).toEqual(['colorOverlay']);
  // dropped on the canvas: the layer under the pointer (Over), not the active one
  await page.evaluate(() => {
    const v = window.pigmentApp.view;
    const p = v.toScreen(130, 90);
    const r = v.canvas.getBoundingClientRect();
    window.__pp.drop(v.canvas, 'application/x-pigment-style', JSON.stringify({ id: 'basic-inner-shadow' }), { x: r.left + p.x, y: r.top + p.y });
  });
  await expect.poll(() => page.evaluate(() => window.pigmentApp.doc.active.name)).toBe('Over');
  expect(await page.evaluate(() => Object.keys(window.pigmentApp.doc.active.styles ?? {}))).toEqual(['innerShadow']);
  // .pigment and PSD keep the applied styles
  const saved = await page.evaluate(async () => {
    const app = window.pigmentApp;
    const { io } = window.__pp;
    const back = await io.readPigment(await io.writePigment(app.doc));
    const psd = await io.openDocument(io.writePsdDocument(app.doc, app.doc.view.compositor), { name: 's.psd' });
    const fx = (d, name) => {
      const l = d.layers().find((x) => x.name === name);
      return Object.keys(l?.styles ?? {}).filter((k) => [].concat(l.styles[k]).some((v) => v?.enabled)).sort();
    };
    const { psdFeatures } = await import('/lib/psd/registry.js');
    return { pigment: [fx(back, 'Under'), fx(back, 'Over')], psd: [fx(psd, 'Under'), fx(psd, 'Over')], effects: psdFeatures().effects };
  });
  expect(saved.pigment).toEqual([['colorOverlay'], ['innerShadow']]);
  if (saved.effects) expect(saved.psd).toEqual([['colorOverlay'], ['innerShadow']]);
  // Clear Style
  await page.locator('[data-panel="styles"] .panel-footer [data-act="clear"]').click();
  expect(await page.evaluate(() => window.pigmentApp.doc.active.styles)).toBeNull();
  expect(errors).toEqual([]);
});

test('styles with patterns: New Style defines a missing pattern and keeps { presetId, name }; a missing pattern turns its effect off', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 120, height: 90 });
  await helpers(page);
  const r = await page.evaluate(async () => {
    const app = window.pigmentApp;
    const { TP, ready, canvas, box } = window.__pp;
    await ready('styles', 'patterns');
    await app.patterns.ready();
    const layer = box('Patterned', [10, 10, 50, 40]);
    // a pattern the library does not have: layer data carries it as pixels only (a pasted or opened layer)
    const dataUrl = canvas(4, 4, '#cc3300').toDataURL('image/png');
    layer.styles = { patternOverlay: { enabled: true, pattern: { dataUrl, name: 'Rust' }, opacity: 1, blend: 'normal', scale: 1 } };
    const nPatterns = app.presets.list('patterns').length;
    const current = app.patterns.currentId();
    const preset = await TP.addStylePreset(app, TP.layerStyleSource(layer), { name: 'Rusty' });
    const ref = preset.data.styles.patternOverlay.pattern;
    const out = { ref, added: app.presets.list('patterns').length - nPatterns, keptCurrent: app.patterns.currentId() === current };
    // applied to another layer: the pixels come back from the pattern preset
    box('Plain', [60, 40, 40, 40]);
    await app.commands.run('layer:style-preset', preset.id, 'api');
    out.applied = app.doc.active.styles.patternOverlay.pattern;
    // the pattern goes: applying again turns the overlay off, with one toast
    await app.patterns.remove([ref.presetId]);
    await app.commands.run('layer:style-preset', preset.id, 'api');
    out.after = app.doc.active.styles;
    out.toasts = window.__pp.toasts();
    return out;
  });
  expect(r.ref).toEqual({ name: 'Rust', presetId: expect.any(String) });
  expect(Object.keys(r.ref).sort()).toEqual(['name', 'presetId']);
  expect(r.added).toBe(1);
  expect(r.keptCurrent).toBe(true);
  expect(r.applied).toMatchObject({ presetId: r.ref.presetId, name: 'Rust', dataUrl: expect.stringMatching(/^data:image\/png/) });
  expect(r.after).toBeNull(); // the only effect is off: no style left
  expect(r.toasts.some((t) => t.includes('"Rust"') && t.includes('missing'))).toBe(true);
  expect(errors).toEqual([]);
});

test('Layer Style dialog: the Styles page replaces the draft, New Style saves it, Make Default and Reset to Default', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 120, height: 90 });
  await helpers(page);
  await page.evaluate(() => window.__pp.box('Styled', [20, 20, 50, 40]));
  await run(page, 'layer:style', 'dialog');
  const dlg = page.locator('.style-dialog');
  await expect(dlg).toBeVisible();
  // Blending Options is still the page it opens on; Styles is the first row
  await expect(dlg.locator('.style-list label').first()).toHaveText('Styles');
  await expect(dlg.locator('.style-list label.current')).toHaveText('Blending Options');
  await dlg.locator('.style-list [data-style="styles"] .style-name').click();
  await dlg.locator('.style-presets .pset-item[data-id="basic-outer-glow"]').click();
  await expect(dlg.locator('.style-list [data-style="outerGlow"] input')).toBeChecked();
  expect(await page.evaluate(() => window.pigmentApp.doc.active.styles?.outerGlow?.enabled)).toBe(true); // live
  // Shift-click adds the stroke to the glow
  await dlg.locator('.style-presets .pset-item[data-id="basic-stroke"]').click({ modifiers: ['Shift'] });
  await expect(dlg.locator('.style-list [data-style="stroke"] input')).toBeChecked();
  await expect(dlg.locator('.style-list [data-style="outerGlow"] input')).toBeChecked();
  // New Style… saves the draft
  await dlg.locator('[data-act="new-style"]').click();
  const ns = page.locator('.dialog', { hasText: 'Include Layer Effects' });
  await ns.locator('input[data-key="name"]').fill('Glow Stroke');
  await ns.locator('.dialog-buttons .btn.primary').click();
  await expect.poll(() => page.evaluate(() => {
    const p = window.pigmentApp.presets.list('styles').find((x) => x.name === 'Glow Stroke');
    return p ? window.__pp.M.enabledEffects(p.data.styles).sort() : null;
  })).toEqual(['outerGlow', 'stroke']);
  await expect(dlg.locator('.style-presets .pset-item[aria-label="Glow Stroke"]')).toHaveCount(1);
  // Make Default on Drop Shadow with distance 17, then Reset to Default brings 17 back
  await dlg.locator('.style-list [data-style="dropShadow"] .style-name').click();
  const distance = () => dlg.locator('.style-pane input[type="number"][data-key="distance"]');
  await distance().fill('17');
  await distance().dispatchEvent('change');
  await dlg.locator('[data-act="make-default"]').click();
  await distance().fill('3');
  await distance().dispatchEvent('change');
  await dlg.locator('[data-act="reset"]').click();
  await expect(distance()).toHaveValue('17');
  expect(await page.evaluate(() => window.pigmentApp.settings.presetPanels.styleDefaults.dropShadow.distance)).toBe(17);
  // OK: one Layer style entry
  const before = await page.evaluate(() => window.pigmentApp.doc.history.index);
  await dlg.locator('.dialog-buttons .btn.primary').click();
  await expect(dlg).toHaveCount(0);
  expect(await page.evaluate(() => window.pigmentApp.doc.history.index)).toBe(before + 1);
  // the next dialog: a Drop Shadow the layer does not have starts from the default made
  await page.evaluate(() => window.__pp.box('Fresh', [70, 40, 30, 30]));
  await run(page, 'layer:style', 'dropShadow');
  await expect(page.locator('.style-dialog .style-pane input[type="number"][data-key="distance"]')).toHaveValue('17');
  await page.keyboard.press('Escape');
  expect(errors).toEqual([]);
});

test('Define Custom Shape: from the work path, the Custom Shape tool and its picker, shapeProps.unit, .pigment and PSD', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 200, height: 160 });
  await helpers(page);
  // a work path: a triangle 60 x 40 px
  await page.evaluate(() => {
    const d = window.pigmentApp.doc;
    d.workPath = { subpaths: [{ closed: true, points: [{ x: 50, y: 20 }, { x: 110, y: 60 }, { x: 50, y: 60 }] }] };
    d.changed('paths');
  });
  expect(await page.evaluate(() => window.pigmentApp.commands.isEnabled('edit:define-custom-shape'))).toBe(true);
  await run(page, 'edit:define-custom-shape');
  const named = page.locator('.dialog', { hasText: 'Shape Name' });
  await named.locator('input').fill('Wedge');
  await named.locator('.dialog-buttons .btn.primary').click();
  await expect.poll(() => page.evaluate(() => window.pigmentApp.presets.list('shapes').some((p) => p.name === 'Wedge'))).toBe(true);
  const shape = await page.evaluate(() => {
    const app = window.pigmentApp;
    const p = app.presets.list('shapes').find((x) => x.name === 'Wedge');
    return { id: p.id, data: p.data, tool: app.tools.opt('shape-custom', 'shape') };
  });
  expect(shape.data).toEqual({ path: { subpaths: [{ closed: true, points: [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }] }] }, width: 60, height: 40 });
  expect(shape.tool).toBe(shape.id);
  // the Custom Shape tool draws it, its outline kept in shapeProps.unit; Defined Proportions are its own 3:2
  await page.evaluate(() => window.pigmentApp.tools.activate('shape-custom'));
  await expect(page.locator('#options-bar .pset-shape-button')).toHaveAttribute('title', 'Shape: Wedge');
  await drag(page, [20, 80], [80, 140]);
  const drawn = await page.evaluate(() => {
    const l = window.pigmentApp.doc.active;
    return { type: l.type, kind: l.shapeKind, props: l.shapeProps };
  });
  expect(drawn).toMatchObject({ type: 'shape', kind: 'custom', props: { x: 20, y: 80, width: 60, height: 60, shape: shape.id } });
  expect(drawn.props.unit).toEqual(shape.data.path);
  const alpha = (x, y) => page.evaluate(([px, py]) => window.__pp.alphaAt(window.pigmentApp.doc.active, px, py), [x, y]);
  expect(await alpha(24, 136)).toBe(255); // inside the wedge, near its square corner
  expect(await alpha(76, 84)).toBe(0); // the box's top-right corner is outside it
  await page.evaluate(() => window.pigmentApp.tools.setOpt('shape-custom', 'constrain', 'defined-proportions'));
  expect(await page.evaluate(() => window.pigmentApp.tools.active.ratio())).toBeCloseTo(1.5, 5);
  await page.evaluate(() => window.pigmentApp.tools.setOpt('shape-custom', 'constrain', 'none'));
  // the picker: a grid of the shapes; a pick sets the tool's shape
  await page.locator('#options-bar .pset-shape-button').click();
  await page.locator('.pset-popover .pset-item[data-id="heart"]').click();
  await expect(page.locator('.pset-popover')).toHaveCount(0);
  expect(await page.evaluate(() => window.pigmentApp.tools.opt('shape-custom', 'shape'))).toBe('heart');
  // the preset goes: the layer still draws its outline, after .pigment and in the PSD
  const r = await page.evaluate(async (id) => {
    const app = window.pigmentApp;
    const { io } = window.__pp;
    app.presets.remove('shapes', [id]);
    const back = await io.readPigment(await io.writePigment(app.doc));
    const bl = back.layers().find((l) => l.type === 'shape');
    const psdDoc = await io.openDocument(io.writePsdDocument(app.doc, app.doc.view.compositor), { name: 'w.psd' });
    const pl = psdDoc.layers().find((l) => l.name === bl.name);
    const at = window.__pp.alphaAt;
    return { unit: bl.shapeProps.unit, inside: at(bl, 24, 136), outside: at(bl, 76, 84), psdInside: at(pl, 24, 136), psdOutside: at(pl, 76, 84) };
  }, shape.id);
  expect(r.unit).toEqual(shape.data.path);
  expect(r.inside).toBe(255);
  expect(r.outside).toBe(0);
  expect(r.psdInside).toBe(255);
  expect(r.psdOutside).toBe(0);
  expect(errors).toEqual([]);
});

test('Shapes panel: a shape dropped on the canvas is one shape layer there (undo removes it); a pick sets the tool\'s shape', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 400, height: 300 });
  await helpers(page);
  await runAwait(page, 'window:panel-shapes');
  await page.locator('[data-panel="shapes"] .pset-item[data-id="star5"]').click();
  expect(await page.evaluate(() => window.pigmentApp.tools.opt('shape-custom', 'shape'))).toBe('star5');
  const h0 = await page.evaluate(() => window.pigmentApp.doc.history.index);
  await page.evaluate(() => {
    const v = window.pigmentApp.view;
    const p = v.toScreen(200, 150);
    const r = v.canvas.getBoundingClientRect();
    window.__pp.drop(v.canvas, 'application/x-pigment-shape', JSON.stringify({ id: 'heart' }), { x: r.left + p.x, y: r.top + p.y });
  });
  await expect.poll(() => page.evaluate(() => window.pigmentApp.doc.active.type)).toBe('shape');
  const r = await page.evaluate(() => {
    const d = window.pigmentApp.doc;
    const l = d.active;
    return { name: l.name, kind: l.shapeKind, props: { ...l.shapeProps, unit: !!l.shapeProps.unit }, entries: d.history.index, label: window.__pp.entry() };
  });
  // a quarter of the shorter side (75 px) for the longer side of the heart (its 0..1 outline is 1 x 0.9), centred on the
  // drop point (within the pixel the screen gives)
  expect(r).toMatchObject({ name: 'Heart 1', kind: 'custom', props: { width: 75, height: 68, shape: 'heart', unit: true }, label: 'Custom Shape' });
  expect(Math.abs(r.props.x + 37.5 - 200)).toBeLessThanOrEqual(1);
  expect(Math.abs(r.props.y + 34 - 150)).toBeLessThanOrEqual(1);
  expect(r.entries - h0).toBe(1);
  expect(await page.evaluate(() => window.__pp.alphaAt(window.pigmentApp.doc.active, 200, 150))).toBe(255);
  await runAwait(page, 'edit:undo');
  expect(await page.evaluate(() => window.pigmentApp.doc.layers().some((l) => l.type === 'shape'))).toBe(false);
  expect(errors).toEqual([]);
});

/** A sampled brush tip defined from a selection (edit:define-brush), picked for the Brush tool. */
async function sampledBrush(page) {
  return page.evaluate(async () => {
    const app = window.pigmentApp;
    const { box } = window.__pp;
    box('Tip', [10, 10, 12, 20], '#000000');
    const { Selection } = await import('/lib/selection.js');
    app.applySelection(Selection.fromRect(app.doc.width, app.doc.height, { x: 8, y: 8, width: 16, height: 24 }), 'replace', 'Rectangular Marquee');
    const preset = await app.commands.run('edit:define-brush', { name: 'Sampled' }, 'api');
    await app.presets.ready('brushes');
    const p = app.presets.list('brushes').find((x) => x.name === 'Sampled');
    await app.commands.run('tool:brush-preset', { id: p.id, tool: 'brush' }, 'api');
    await app.commands.run('select:none', undefined, 'api');
    return { id: p.id, blob: p.data.tip.sample?.blob ?? null, kind: p.data.tip.kind, defined: !!preset };
  });
}

test('Tool Presets: New Tool Preset from the picker, Current Tool Only, a pick, Reset Tool and Reset All Tools', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 120, height: 90 });
  await helpers(page);
  await page.evaluate(() => {
    const app = window.pigmentApp;
    app.tools.activate('brush');
    app.tools.setOpt('brush', 'opacity', 0.4);
    app.tools.setOpt('brush', 'size', 33);
  });
  await page.locator('#options-bar .pset-tool-picker').click();
  await page.locator('.pset-picker [data-act="new"]').click();
  const dlg = page.locator('.dialog', { hasText: 'Include Color' });
  await expect(dlg.locator('input[data-key="name"]')).toHaveValue('Brush Tool 1');
  await dlg.locator('input[data-key="name"]').fill('Soft 40');
  await dlg.locator('input[data-key="includeColor"]').check();
  await dlg.locator('.dialog-buttons .btn.primary').click();
  await expect.poll(() => page.evaluate(() => window.pigmentApp.presets.list('tool-presets').length)).toBe(1);
  const saved = await page.evaluate(() => window.pigmentApp.presets.list('tool-presets')[0].data);
  expect(saved).toMatchObject({ tool: 'brush', options: { opacity: 0.4, size: 33 }, color: '#000000' });
  expect(saved.brush.tip.size).toBe(33);
  expect(saved.options.brush).toBeUndefined();
  // another tool: Current Tool Only hides the preset; Show All lists it; a pick switches back to the Brush with it
  await page.evaluate(() => {
    const app = window.pigmentApp;
    app.tools.activate('eraser');
    app.tools.setOpt('brush', 'opacity', 1);
    app.tools.setOpt('brush', 'size', 5);
    app.setColors({ foreground: '#ff0000' });
  });
  await page.locator('#options-bar .pset-tool-picker').click();
  await expect(page.locator('.pset-picker .pset-item')).toHaveCount(0);
  await page.locator('.pset-picker input[data-k="currentToolOnly"]').uncheck();
  await expect(page.locator('.pset-picker .pset-item')).toHaveCount(1);
  await page.locator('.pset-picker .pset-item').click();
  await expect.poll(() => page.evaluate(() => window.pigmentApp.tools.active.id)).toBe('brush');
  const applied = await page.evaluate(async () => {
    const app = window.pigmentApp;
    const { toolBrush } = await import('/lib/brush/tool-brush.js');
    return { opacity: app.tools.opt('brush', 'opacity'), size: app.tools.opt('brush', 'size'), tip: toolBrush(app, 'brush').preset.tip.size, fg: app.settings.foreground };
  });
  expect(applied).toEqual({ opacity: 0.4, size: 33, tip: 33, fg: '#000000' });
  // the Tool Presets panel lists it with Current Tool Only off (the shared setting)
  await runAwait(page, 'window:panel-tool-presets');
  await expect(page.locator('[data-panel="tool-presets"] input[data-k="currentToolOnly"]')).not.toBeChecked();
  await expect(page.locator('[data-panel="tool-presets"] .pset-item')).toHaveCount(1);
  // Reset Tool, Reset All Tools (asks from the panel)
  await runAwait(page, 'tool:reset', 'brush');
  expect(await page.evaluate(() => [window.pigmentApp.tools.opt('brush', 'opacity'), window.pigmentApp.settings.tools?.brush ?? null])).toEqual([1, null]);
  await page.evaluate(() => window.pigmentApp.tools.setOpt('eraser', 'opacity', 0.3));
  await page.locator('[data-panel="tool-presets"] .panel-footer [data-act="menu"]').click();
  await page.locator('.popover-item', { hasText: 'Reset All Tools' }).click();
  await page.locator('.dialog', { hasText: 'Reset all tools' }).locator('.dialog-buttons .btn.primary').click();
  await expect.poll(() => page.evaluate(() => Object.keys(window.pigmentApp.settings.tools ?? {}).length)).toBe(0);
  expect(errors).toEqual([]);
});

test('a tool preset with a sampled tip survives export and import (.pigment-presets and .tpl) and paints with that tip', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 120, height: 90 });
  await helpers(page);
  const tip = await sampledBrush(page);
  expect(tip.kind).toBe('sampled');
  expect(tip.blob).toMatch(/^tip-.*\.png$/);
  const r = await page.evaluate(async (blob) => {
    const app = window.pigmentApp;
    const { TP } = window.__pp;
    const F = await import('/lib/preset-formats.js');
    const { toolBrush, prepareBrush, sampleCanvas } = await import('/lib/brush/tool-brush.js');
    await window.__pp.ready('tool-presets', 'brushes');
    const data = TP.captureToolPreset(app, 'brush');
    const p = app.presets.add('tool-presets', { name: 'Stamp', data });
    const out = { tip: data.brush.tip.sample?.blob };
    const json = await F.exportPresetBytes(app, 'tool-presets', [p.id]);
    const tpl = await F.exportPresetBytes(app, 'tool-presets', [p.id], 'tpl');
    out.extra = Object.keys(JSON.parse(new TextDecoder().decode(json.bytes)).extraBlobs?.brushes ?? {});
    // a profile without the preset and without the tip
    app.presets.remove('tool-presets', [p.id]);
    await app.presets.backend.removeBlob('brushes', blob);
    out.gone = !(await app.presets.readBlob('brushes', blob));
    for (const [name, file] of [['Back.pigment-presets', json], ['Back.tpl', tpl]]) {
      await app.presets.backend.removeBlob('brushes', blob);
      const res = await F.importPresetBytes(app, [{ name, bytes: file.bytes }], { kinds: ['tool-presets'] });
      const back = app.presets.list('tool-presets').find((x) => x.name === 'Stamp' && x.id !== out['Back.pigment-presets:id']);
      out[name] = { added: res.added['tool-presets'] ?? 0, kind: back?.data.brush?.tip.kind, blob: back?.data.brush?.tip.sample?.blob, stored: !!(await app.presets.readBlob('brushes', back?.data.brush?.tip.sample?.blob ?? 'x')) };
      out[`${name}:id`] = back?.id;
    }
    // picking the imported preset gives the Brush that tip, decoded
    app.tools.activate('eraser');
    await app.commands.run('tool:preset', out['Back.pigment-presets:id'], 'api');
    const tb = toolBrush(app, 'brush').preset;
    await prepareBrush(app, tb);
    out.applied = { tool: app.tools.active.id, kind: tb.tip.kind, decoded: !!sampleCanvas(tb.tip.sample.hash) };
    return out;
  }, tip.blob);
  expect(r.tip).toBe(tip.blob);
  expect(r.extra).toEqual([tip.blob]);
  expect(r.gone).toBe(true);
  expect(r['Back.pigment-presets']).toEqual({ added: 1, kind: 'sampled', blob: tip.blob, stored: true });
  expect(r['Back.tpl']).toMatchObject({ added: 1, kind: 'sampled', stored: true });
  expect(r.applied).toEqual({ tool: 'brush', kind: 'sampled', decoded: true });
  // the tip paints: a stroke leaves paint on the layer
  await page.evaluate(() => window.__pp.box('Paint', [0, 0, 120, 90], 'rgba(0,0,0,0)'));
  await drag(page, [20, 45], [100, 45]);
  expect((await pixel(page, 60, 45)).slice(0, 3)).not.toEqual([255, 255, 255]);
  expect(errors).toEqual([]);
});

test('a type tool preset picked with a text layer active edits no layer; the next text uses it', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 300, height: 200 });
  await helpers(page);
  const r = await page.evaluate(async () => {
    const app = window.pigmentApp;
    const { TP } = window.__pp;
    const { typeDefaults } = await import('/lib/type/target.js');
    await window.__pp.ready('tool-presets');
    app.tools.activate('type-horizontal');
    app.tools.setOpt('type-horizontal', 'size', 48);
    const data = TP.captureToolPreset(app, 'type-horizontal');
    const p = app.presets.add('tool-presets', { name: 'Headline', data });
    app.tools.setOpt('type-horizontal', 'size', 12);
    // a text layer, active
    const { TextLayer } = await import('/lib/document.js');
    const { structural } = await import('/lib/layer-ops.js');
    const M = await import('/lib/type/model.js');
    const layer = new TextLayer({ content: M.fromPlain('Hello', { size: 20, color: '#000000' }), x: 20, y: 30 });
    structural(app, 'Add', () => {
      app.doc.add(layer);
      app.doc.setActive(layer);
    });
    app.tools.activate('move');
    const before = JSON.stringify(layer.content) + JSON.stringify(layer.typeOptions ?? null);
    const h0 = app.doc.history.index;
    await app.commands.run('tool:preset', p.id, 'api');
    return {
      hasType: !!data.type,
      tool: app.tools.active.id,
      same: before === JSON.stringify(layer.content) + JSON.stringify(layer.typeOptions ?? null),
      entries: app.doc.history.index - h0,
      size: app.tools.opt('type-horizontal', 'size'),
      next: typeDefaults(app).char.size,
    };
  });
  expect(r).toEqual({ hasType: true, tool: 'type-horizontal', same: true, entries: 0, size: 48, next: 48 });
  expect(errors).toEqual([]);
});

test('actions: tool:preset and layer:style-preset record their data and replay where the presets are gone', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 120, height: 90 });
  await helpers(page);
  const r = await page.evaluate(async () => {
    const app = window.pigmentApp;
    const { TP, box, ready } = window.__pp;
    const M = await import('/lib/actions/model.js');
    await ready('tool-presets', 'styles');
    box('A', [10, 10, 40, 40]);
    app.tools.activate('brush');
    app.tools.setOpt('brush', 'opacity', 0.25);
    const tp = app.presets.add('tool-presets', { name: 'Quarter', data: TP.captureToolPreset(app, 'brush') });
    const st = app.presets.add('styles', { name: 'Mine', data: { styles: { stroke: { enabled: true, size: 6, position: 'outside', color: '#ff0000', opacity: 1, blend: 'normal' } } } });
    app.tools.setOpt('brush', 'opacity', 1);
    const set = M.makeSet('Presets');
    const action = M.makeAction('Apply both', []);
    set.actions.push(action);
    app.actions.sets.push(set);
    app.actions.selection = { set: set.id, action: action.id, step: null };
    app.actions.record(action);
    await app.commands.run('tool:preset', tp.id, 'panel');
    await app.commands.run('layer:style-preset', st.id, 'panel');
    app.actions.stop();
    const steps = action.steps.map((s) => ({ command: s.command, arg: s.arg }));
    // the presets go; a new layer; the action plays
    app.presets.remove('tool-presets', [tp.id]);
    app.presets.remove('styles', [st.id]);
    app.tools.setOpt('brush', 'opacity', 1);
    app.tools.activate('move');
    box('B', [60, 30, 40, 40]);
    await app.actions.play(action, { quiet: true });
    return { steps, opacity: app.tools.opt('brush', 'opacity'), tool: app.tools.active.id, styles: app.doc.active.styles, name: app.doc.active.name };
  });
  expect(r.steps.map((s) => s.command)).toEqual(['tool:preset', 'layer:style-preset']);
  expect(r.steps[0].arg).toMatchObject({ tool: 'brush', options: { opacity: 0.25 } });
  expect(r.steps[1].arg).toEqual({ styles: { stroke: { enabled: true, size: 6, position: 'outside', color: '#ff0000', opacity: 1, blend: 'normal' } } });
  expect(r).toMatchObject({ opacity: 0.25, tool: 'brush', name: 'B', styles: { stroke: { size: 6, color: '#ff0000' } } });
  expect(errors).toEqual([]);
});

test('16-bit and Grayscale documents: a style applies and draws; a dropped shape is a shape layer', async ({ page }) => {
  const errors = await openApp(page);
  for (const mode of ['depth16', 'gray']) {
    await newDoc(page, { width: 160, height: 120 });
    await helpers(page);
    await page.evaluate(async (m) => {
      const app = window.pigmentApp;
      if (m === 'depth16') await app.commands.run('image:depth', 16, 'api');
      else await app.commands.run('image:mode', { mode: 'grayscale', silent: true, flatten: false }, 'api');
      window.__pp.box('L', [40, 30, 60, 50], '#808080');
    }, mode);
    const r = await page.evaluate(async () => {
      const app = window.pigmentApp;
      await app.commands.run('layer:style-preset', 'basic-stroke', 'api');
      const { dropShape } = window.__pp.TP;
      await dropShape(app, JSON.stringify({ id: 'heart' }), { x: 30, y: 30 });
      return { depth: app.doc.depth ?? 8, mode: app.doc.mode ?? 'rgb', layers: app.doc.layers().map((l) => l.type), label: window.__pp.entry() };
    });
    expect(r.layers).toContain('shape');
    expect(r.label).toBe('Custom Shape');
    // the stroke is drawn black outside the layer's edge
    expect((await pixel(page, 101, 55)).slice(0, 3)).toEqual([0, 0, 0]);
  }
  expect(errors).toEqual([]);
});
