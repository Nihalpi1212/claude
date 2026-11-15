// Regressions from the 0.4 cross-feature hunt, area "styles": rasterizing keeps the Blending Options, a clipping mask
// leaves the base's own alpha alone, PSD tells what it drops, Create Layers keeps restricted channels and warns when it
// cannot match, the Angle of a global-light effect moves the Global Light, Paste Layer Style skips layers that take no
// style and carries the blending options, an effect row opens its own instance, and an emptied number field keeps its
// value.
import { test, expect } from '@playwright/test';
import { openApp, newDoc, run, runAwait, pixel, confirmDialog } from './helpers.mjs';

/** The flattened document as an array of bytes. */
const composite = (page) => page.evaluate(() => {
  const d = window.pigmentApp.doc;
  return Array.from(d.view.compositor.composite(d).getContext('2d').getImageData(0, 0, d.width, d.height).data);
});
const maxDiff = (a, b) => a.reduce((m, v, i) => Math.max(m, Math.abs(v - b[i])), 0);

/** A white 200 x 160 document with a dark square at the top left and a layer from `spec` above it, made active. */
async function setup(page, spec) {
  await newDoc(page, { width: 200, height: 160, background: 'white' });
  return page.evaluate(async (s) => {
    const app = window.pigmentApp;
    const { RasterLayer, ShapeLayer, createCanvas } = await import('/lib/document.js');
    const d = app.doc;
    const dark = createCanvas(100, 100);
    dark.getContext('2d').fillStyle = '#202020';
    dark.getContext('2d').fillRect(0, 0, 100, 100);
    d.add(new RasterLayer({ name: 'Dark', canvas: dark, x: 0, y: 0 }), d.root, 1);
    let layer;
    if (s.kind === 'shape') {
      const pts = [[40, 40], [160, 40], [160, 130], [40, 130]].map(([x, y]) => ({ x, y, anchor: { x, y }, in: { x, y }, out: { x, y } }));
      layer = new ShapeLayer({ name: 'Shape', path: { subpaths: [{ closed: true, points: pts }] }, fill: { type: 'solid', color: '#ff8800' }, shapeKind: 'path', ...s.props });
    } else {
      const c = createCanvas(80, 60);
      c.getContext('2d').fillStyle = s.color ?? '#ff8800';
      c.getContext('2d').fillRect(0, 0, 80, 60);
      layer = new RasterLayer({ name: 'Box', canvas: c, x: 60, y: 40, ...s.props });
    }
    d.add(layer, d.root, 2);
    d.setActive(layer);
    return layer.id;
  }, spec);
}

const CHANNELS_OFF = { channels: { r: true, g: false, b: true } };
const BLEND_IF = { blendIf: { gray: { under: [0, 0, 100, 160] } }, channels: { r: true, g: false, b: true } };

test('Rasterize Layer keeps the Blending Options of a shape layer and the image stays the same', async ({ page }) => {
  const errors = await openApp(page);
  await setup(page, { kind: 'shape', props: { blending: BLEND_IF, styles: { stroke: { enabled: true, size: 3 } } } });
  const before = await composite(page);
  await runAwait(page, 'layer:rasterize');
  const after = await page.evaluate(() => {
    const a = window.pigmentApp.doc.active;
    return { type: a.type, blending: a.blending };
  });
  expect(after.type).toBe('raster');
  expect(after.blending?.channels?.g).toBe(false);
  expect(after.blending?.blendIf?.gray?.under).toEqual([0, 0, 100, 160]);
  expect(maxDiff(before, await composite(page))).toBeLessThanOrEqual(2);
  expect(errors).toEqual([]);
});

test('Rasterize Layer Style bakes the effects and keeps restricted channels live; Blend If is kept with a notice', async ({ page }) => {
  const errors = await openApp(page);
  await setup(page, { kind: 'raster', props: { blending: CHANNELS_OFF, styles: { stroke: { enabled: true, size: 4, color: '#0000ff' } } } });
  const before = await composite(page);
  await runAwait(page, 'layer:rasterize-style');
  const a = await page.evaluate(() => ({ styles: window.pigmentApp.doc.active.styles, g: window.pigmentApp.doc.active.blending?.channels?.g }));
  expect(a.styles).toBeNull();
  expect(a.g).toBe(false);
  expect(maxDiff(before, await composite(page))).toBeLessThanOrEqual(2);

  await setup(page, { kind: 'raster', props: { blending: BLEND_IF, styles: { stroke: { enabled: true, size: 4 } } } });
  await runAwait(page, 'layer:rasterize-style');
  expect(await page.evaluate(() => window.pigmentApp.doc.active.blending?.blendIf?.gray?.under)).toEqual([0, 0, 100, 160]);
  await expect(page.locator('#toasts .toast', { hasText: 'Blend If and knockout' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('a clipped layer leaves the base unchanged where it has no pixels (the base alpha counts once)', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 100, height: 60, background: 'white' });
  await page.evaluate(async () => {
    const app = window.pigmentApp;
    const { RasterLayer, createCanvas } = await import('/lib/document.js');
    const d = app.doc;
    const base = createCanvas(100, 60);
    base.getContext('2d').fillStyle = 'rgba(0, 0, 0, 0.5)';
    base.getContext('2d').fillRect(0, 0, 100, 60);
    d.add(new RasterLayer({ name: 'Base', canvas: base, x: 0, y: 0 }), d.root, 1);
    const red = createCanvas(50, 60);
    red.getContext('2d').fillStyle = '#ff0000';
    red.getContext('2d').fillRect(0, 0, 50, 60);
    const top = new RasterLayer({ name: 'Red', canvas: red, x: 50, y: 0 });
    d.add(top, d.root, 2);
    d.setActive(top);
  });
  const alone = await pixel(page, 20, 30);
  await runAwait(page, 'layer:clip');
  expect(await page.evaluate(() => window.pigmentApp.doc.active.clip)).toBe(true);
  const left = await pixel(page, 20, 30), right = await pixel(page, 70, 30);
  expect(maxDiff(left, alone)).toBeLessThanOrEqual(1);
  expect(maxDiff(right, [255, 127, 127, 255])).toBeLessThanOrEqual(2);
  expect(errors).toEqual([]);
});

test('saving a PSD tells that layer effects and Blending Options are not kept', async ({ page }) => {
  const errors = await openApp(page);
  await setup(page, { kind: 'raster', props: { fillOpacity: 0.5, styles: { dropShadow: { enabled: true } }, blending: { knockout: 'deep' } } });
  await page.evaluate(() => (window.__pigmentTest.nextSavePath = 'mem:/styled.psd'));
  await runAwait(page, 'file:save-as');
  await expect.poll(() => page.evaluate(() => !!window.__pigmentTest.written['mem:/styled.psd'])).toBe(true);
  await expect(page.locator('#toasts .toast', { hasText: '1 layer with layer effects or Blending Options was saved without them' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('Create Layers keeps restricted channels on the created layers and warns when knockout cannot be reproduced', async ({ page }) => {
  const errors = await openApp(page);
  await setup(page, { kind: 'raster', props: { blending: CHANNELS_OFF, styles: { stroke: { enabled: true, size: 4, color: '#000000' }, dropShadow: { enabled: true, distance: 8, size: 0, opacity: 1, blend: 'normal' } } } });
  const before = await composite(page);
  await runAwait(page, 'layer:style-create-layers');
  const made = await page.evaluate(() => window.pigmentApp.doc.layers().filter((l) => / Stroke$|Drop Shadow$/.test(l.name)).map((l) => l.blending?.channels?.g));
  expect(made.length).toBe(2);
  expect(made).toEqual([false, false]);
  expect(maxDiff(before, await composite(page))).toBeLessThanOrEqual(2);
  await expect(page.locator('#toasts .toast', { hasText: 'cannot be reproduced with layers' })).toHaveCount(0);

  await setup(page, { kind: 'raster', props: { fillOpacity: 0.5, blending: { knockout: 'shallow' }, styles: { stroke: { enabled: true, size: 4 } } } });
  await runAwait(page, 'layer:style-create-layers');
  await expect(page.locator('#toasts .toast', { hasText: 'cannot be reproduced with layers' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('with Use Global Light on, the Angle field moves the Global Light: Cancel restores it, OK records it with the style', async ({ page }) => {
  const errors = await openApp(page);
  await setup(page, { kind: 'raster', props: { styles: { dropShadow: { enabled: true, useGlobalLight: true, distance: 6, size: 0, opacity: 1, blend: 'normal', color: '#000000' } } } });
  // a second layer whose shadow uses the global light too
  await page.evaluate(async () => {
    const { RasterLayer, createCanvas } = await import('/lib/document.js');
    const d = window.pigmentApp.doc;
    const c = createCanvas(20, 20);
    c.getContext('2d').fillStyle = '#00ff00';
    c.getContext('2d').fillRect(0, 0, 20, 20);
    const o = new RasterLayer({ name: 'Other', canvas: c, x: 150, y: 120, styles: { dropShadow: { enabled: true, useGlobalLight: true, distance: 8, size: 0, opacity: 1, blend: 'normal', color: '#000000' } } });
    const box = d.active;
    d.add(o, d.root, 3);
    d.setActive(box);
  });
  const hist = await page.evaluate(() => window.pigmentApp.doc.history.index);
  // the other layer's shadow at 120 degrees falls to the lower right (under it at (172, 143)); at 0 degrees, to its left
  expect(await pixel(page, 172, 143)).toEqual([0, 0, 0, 255]);
  const openDialog = async () => {
    await run(page, 'layer:style', 'dropShadow');
    await expect(page.locator('.style-dialog')).toBeVisible();
  };
  const angle = page.locator('.style-dialog .style-pane input[type="number"][data-key="angle"]');
  await openDialog();
  await expect(angle).toHaveValue('120');
  await angle.fill('0');
  await angle.dispatchEvent('change');
  await expect.poll(() => page.evaluate(() => window.pigmentApp.doc.globalLight?.angle)).toBe(0);
  await expect.poll(() => pixel(page, 172, 143)).not.toEqual([0, 0, 0, 255]);
  expect(await pixel(page, 144, 128)).toEqual([0, 0, 0, 255]);
  await page.locator('.style-dialog .dialog-buttons [data-value="null"]').click();
  await expect.poll(() => page.evaluate(() => window.pigmentApp.doc.globalLight ?? null)).toBeNull();
  expect(await pixel(page, 172, 143)).toEqual([0, 0, 0, 255]);

  await openDialog();
  await angle.fill('0');
  await angle.dispatchEvent('change');
  // another field edited afterwards does not write the shown global angle into the effect
  const distance = page.locator('.style-dialog .style-pane input[type="number"][data-key="distance"]');
  await distance.fill('7');
  await distance.dispatchEvent('change');
  await confirmDialog(page);
  const after = await page.evaluate(() => {
    const d = window.pigmentApp.doc;
    return { gl: d.globalLight?.angle, own: d.active.styles.dropShadow.angle, steps: d.history.index };
  });
  expect(after.gl).toBe(0);
  expect(after.own).toBe(120); // the effect keeps its own angle for when the box is unticked
  expect(after.steps).toBe(hist + 1);
  await runAwait(page, 'edit:undo');
  expect(await page.evaluate(() => window.pigmentApp.doc.globalLight?.angle ?? 120)).toBe(120);
  expect(errors).toEqual([]);
});

test('Paste Layer Style skips the Background and adjustment layers and carries the blending options', async ({ page }) => {
  const errors = await openApp(page);
  await setup(page, { kind: 'raster', props: { fillOpacity: 0.3, blend: 'multiply', blending: { knockout: 'shallow' }, styles: { innerGlow: { enabled: true, color: '#ffff00' } } } });
  await runAwait(page, 'layer:copy-style');
  // the Background takes no style
  await page.evaluate(() => window.pigmentApp.doc.setActive(window.pigmentApp.doc.layers().find((l) => l.name === 'Background')));
  expect(await page.evaluate(() => window.pigmentApp.commands.isEnabled('layer:paste-style'))).toBe(false);
  await runAwait(page, 'layer:paste-style');
  expect(await page.evaluate(() => window.pigmentApp.doc.active.styles ?? null)).toBeNull();
  // an adjustment layer neither
  await runAwait(page, 'layer:new-adjustment', { kind: 'invert' });
  expect(await page.evaluate(() => window.pigmentApp.doc.active.type)).toBe('adjustment');
  await runAwait(page, 'layer:paste-style');
  expect(await page.evaluate(() => window.pigmentApp.doc.active.styles ?? null)).toBeNull();
  // a plain layer takes the effects with the mode, the fill opacity and the advanced blending, in one step
  await page.evaluate(() => window.pigmentApp.doc.setActive(window.pigmentApp.doc.layers().find((l) => l.name === 'Dark')));
  const steps = await page.evaluate(() => window.pigmentApp.doc.history.index);
  await runAwait(page, 'layer:paste-style');
  const t = await page.evaluate(() => {
    const a = window.pigmentApp.doc.active;
    return { glow: !!a.styles?.innerGlow, fill: a.fillOpacity, blend: a.blend, knockout: a.blending?.knockout, steps: window.pigmentApp.doc.history.index };
  });
  expect(t).toEqual({ glow: true, fill: 0.3, blend: 'multiply', knockout: 'shallow', steps: steps + 1 });
  // Clear Layer Style resets them too
  await runAwait(page, 'layer:clear-style');
  const c = await page.evaluate(() => {
    const a = window.pigmentApp.doc.active;
    return { styles: a.styles ?? null, fill: a.fillOpacity, blend: a.blend, blending: a.blending ?? null };
  });
  expect(c).toEqual({ styles: null, fill: 1, blend: 'normal', blending: null });
  // a layer with blending options only can be copied
  await page.evaluate(() => {
    const a = window.pigmentApp.doc.active;
    a.blending = { knockout: 'deep' };
    a.touch();
  });
  expect(await page.evaluate(() => window.pigmentApp.commands.isEnabled('layer:copy-style'))).toBe(true);
  expect(errors).toEqual([]);
});

test('double-clicking the second instance of an effect in the Layers panel opens that instance', async ({ page }) => {
  const errors = await openApp(page);
  await setup(page, { kind: 'raster', props: { styles: { dropShadow: [{ enabled: true, color: '#ff0000', size: 5 }, { enabled: true, color: '#00ff00', size: 20 }] } } });
  await page.evaluate(() => window.pigmentApp.panels.show('layers', { reveal: true }));
  const row = page.locator('[data-panel="layers"] .layer-effect-row[data-effect="dropShadow"][data-index="1"] .layer-name');
  await expect(row).toBeVisible();
  await row.dblclick();
  await expect(page.locator('.style-dialog .style-pane h3')).toHaveText('Drop Shadow (2 of 2)');
  await expect(page.locator('.style-dialog .style-list [data-style="dropShadow"][data-index="1"]')).toHaveClass(/current/);
  await page.locator('.style-dialog .dialog-buttons [data-value="null"]').click();
  expect(errors).toEqual([]);
});

test('an emptied number field in the Layer Style dialog keeps its value on Tab and on OK', async ({ page }) => {
  const errors = await openApp(page);
  await setup(page, { kind: 'raster', props: { styles: { dropShadow: { enabled: true, distance: 15, size: 8 } } } });
  await run(page, 'layer:style', 'dropShadow');
  const field = (k) => page.locator(`.style-dialog .style-pane input[type="number"][data-key="${k}"]`);
  await field('distance').click();
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Delete');
  await page.keyboard.press('Tab');
  await expect(field('distance')).toHaveValue('15');
  await field('size').click();
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Backspace');
  await confirmDialog(page);
  const ds = await page.evaluate(() => {
    const s = window.pigmentApp.doc.active.styles.dropShadow;
    return { distance: s.distance, size: s.size };
  });
  expect(ds).toEqual({ distance: 15, size: 8 });
  expect(errors).toEqual([]);
});
