// layer-style-blending (Pigment 0.4, ARCHITECTURE.md "0.4 features", package 5): the Blending Options page (fill,
// channels, knockout, Blend If, the five check boxes), styles on groups, Create Layers, Hide All Effects, Scale Effects,
// and the compositor's cost: a styled group is not restyled by a brush dab next to it.
import { test, expect } from '@playwright/test';
import { openApp, newDoc, run, runAwait, pixel, historyLength, confirmDialog } from './helpers.mjs';

const dialog = (page) => page.locator('.style-dialog');
const pane = (page) => page.locator('.style-dialog .style-pane');

/**
 * A 200 x 160 document with a white Background, then `layers` added bottom to top: each { name, color, x, y, w, h,
 * ...props } is a filled raster layer, { name, group: true, ...props } a group; `parent` names a group made earlier.
 */
async function build(page, { layers = [] } = {}) {
  await newDoc(page, { width: 200, height: 160, background: 'white' });
  await page.evaluate(async (layers) => {
    const app = window.pigmentApp;
    const d = app.doc;
    const { RasterLayer, GroupLayer, createCanvas } = await import('/lib/document.js');
    d.root.children[0].name = 'Background';
    const byName = {};
    for (const spec of layers) {
      const { name, color, x, y, w, h, parent, group, ...props } = spec;
      let layer;
      if (group) layer = new GroupLayer({ name, blend: 'pass-through', ...props });
      else {
        const c = createCanvas(w, h);
        const g = c.getContext('2d');
        g.fillStyle = color;
        g.fillRect(0, 0, w, h);
        layer = new RasterLayer({ name, canvas: c, x, y, ...props });
      }
      const p = parent ? byName[parent] : d.root;
      d.add(layer, p, p.children.length);
      byName[name] = layer;
    }
    d.setActive(d.layers().filter((l) => !l.isGroup).pop());
    d.changed('tree');
  }, layers);
}

const enabled = (page, id) => page.evaluate((c) => window.pigmentApp.commands.isEnabled(c), id);

const select = (page, name) => page.evaluate((n) => {
  const d = window.pigmentApp.doc;
  d.setActive(d.layers().find((l) => l.name === n));
}, name);

const prop = (page, name, key) => page.evaluate(([n, k]) => {
  const l = window.pigmentApp.doc.layers().find((x) => x.name === n);
  return JSON.parse(JSON.stringify(l[k] ?? null));
}, [name, key]);

const near = (a, b, tol = 2) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= tol);

test('knockout Deep through a group shows the Background; Shallow shows the bottom of the group', async ({ page }) => {
  const errors = await openApp(page);
  await build(page, {
    layers: [
      { name: 'Red', color: '#ff0000', x: 0, y: 0, w: 200, h: 160 },
      { name: 'Group', group: true, blend: 'normal' },
      { name: 'Blue', color: '#0000ff', x: 20, y: 20, w: 120, h: 100, parent: 'Group' },
      { name: 'Cutter', color: '#00ff00', x: 40, y: 40, w: 40, h: 40, parent: 'Group' },
    ],
  });
  await select(page, 'Cutter');
  await run(page, 'layer:style', 'dialog');
  await expect(dialog(page)).toBeVisible();
  await expect(pane(page).locator('h3')).toHaveText('Blending Options');
  // Fill 0 and Knockout Deep: the Background (white) shows through the red and the blue
  await pane(page).locator('input[type="number"][data-key="fillOpacity"]').fill('0');
  await pane(page).locator('input[type="number"][data-key="fillOpacity"]').dispatchEvent('change');
  await pane(page).locator('select[data-key="knockout"]').selectOption('deep');
  expect(await pixel(page, 60, 60)).toEqual([255, 255, 255, 255]);
  expect(await pixel(page, 30, 30)).toEqual([0, 0, 255, 255]);
  // Shallow in an isolated group: down to the group's start, which is transparent, so the red below the group shows
  await pane(page).locator('select[data-key="knockout"]').selectOption('shallow');
  expect(await pixel(page, 60, 60)).toEqual([255, 0, 0, 255]);
  await pane(page).locator('select[data-key="knockout"]').selectOption('deep');
  await confirmDialog(page);
  expect(await prop(page, 'Cutter', 'blending')).toMatchObject({ knockout: 'deep' });
  expect(await prop(page, 'Cutter', 'fillOpacity')).toBe(0);
  expect(await pixel(page, 60, 60)).toEqual([255, 255, 255, 255]);
  // Transparency Shapes Layer off: a hole in the layer knocks out too (its whole content box)
  await page.evaluate(() => {
    const l = window.pigmentApp.doc.layers().find((x) => x.name === 'Cutter');
    l.canvas.getContext('2d').clearRect(10, 10, 20, 20);
    l.blending = { ...l.blending, transparencyShapes: false };
    l.touch();
  });
  expect(await pixel(page, 60, 60)).toEqual([255, 255, 255, 255]);
  await page.evaluate(() => {
    const l = window.pigmentApp.doc.layers().find((x) => x.name === 'Cutter');
    l.blending = { ...l.blending, transparencyShapes: true };
    l.touch();
  });
  expect(await pixel(page, 60, 60)).toEqual([0, 0, 255, 255]);
  expect(errors).toEqual([]);
});

test('Blend If hides the dark pixels of the upper layer; the split slider fades them; channels restrict', async ({ page }) => {
  const errors = await openApp(page);
  // a layer "Tones" with a dark, a light and a mid part over a red layer
  await build(page, {
    layers: [
      { name: 'Red', color: '#ff0000', x: 0, y: 0, w: 200, h: 160 },
      { name: 'Tones', color: 'rgba(0, 0, 0, 0)', x: 0, y: 0, w: 200, h: 160 },
    ],
  });
  await page.evaluate(() => {
    const d = window.pigmentApp.doc;
    const tones = d.layers().find((l) => l.name === 'Tones');
    const g = tones.canvas.getContext('2d');
    for (const [color, x, y] of [['#202020', 10, 10], ['#e0e0e0', 70, 10], ['#808080', 10, 80]]) {
      g.fillStyle = color;
      g.fillRect(x, y, 60, 60);
    }
    tones.touch();
  });
  await run(page, 'layer:style', 'dialog');
  await expect(dialog(page)).toBeVisible();
  const thisNum = (i) => pane(page).locator(`.bif-row[data-which="this"] input[data-key="this-${i}"]`);
  // This Layer black at 100 (hard): the dark part (0x20) goes, the mid (0x80) and light parts stay
  for (const i of [0, 1]) {
    await thisNum(i).fill('100');
    await thisNum(i).dispatchEvent('change');
  }
  expect(await pixel(page, 30, 30)).toEqual([255, 0, 0, 255]);
  expect(await pixel(page, 30, 100)).toEqual([128, 128, 128, 255]);
  expect(await pixel(page, 100, 30)).toEqual([224, 224, 224, 255]);
  // split the black slider with Alt-drag on its right half: the mid tone fades between the halves
  await thisNum(0).fill('64');
  await thisNum(0).dispatchEvent('change');
  const handle = pane(page).locator('.bif-row[data-which="this"] .bif-handle[data-i="1"]');
  const box = await handle.boundingBox();
  const bar = await pane(page).locator('.bif-row[data-which="this"] .bif-bar').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.down('Alt');
  await page.mouse.down();
  await page.mouse.move(bar.x + (192 / 255) * bar.width, box.y + box.height / 2, { steps: 6 });
  await page.mouse.up();
  await page.keyboard.up('Alt');
  const r = (await prop(page, 'Tones', 'blending')).blendIf.gray.this;
  expect(r[0]).toBe(64);
  expect(r[1]).toBeGreaterThan(150);
  // 0x80 = 128 lies between the halves: partly shown over the red
  const mid = await pixel(page, 30, 100);
  expect(mid[0]).toBeGreaterThan(128);
  expect(mid[1]).toBeGreaterThan(5);
  expect(mid[1]).toBeLessThan(128);
  // the Underlying Layer: red under everything has gray 76; white at 50 hides the layer wherever it lies over red
  await pane(page).locator('select[data-key="blendIfChannel"]').selectOption('gray');
  for (const i of [0, 1]) {
    await thisNum(i).fill('0');
    await thisNum(i).dispatchEvent('change');
  }
  const underNum = (i) => pane(page).locator(`.bif-row[data-which="under"] input[data-key="under-${i}"]`);
  for (const i of [2, 3]) {
    await underNum(i).fill('50');
    await underNum(i).dispatchEvent('change');
  }
  expect(await pixel(page, 100, 30)).toEqual([255, 0, 0, 255]);
  // channels: only green writes (Blend If back to the default)
  for (const i of [2, 3]) {
    await underNum(i).fill('255');
    await underNum(i).dispatchEvent('change');
  }
  await pane(page).locator('input[data-key="channel-r"]').uncheck();
  await pane(page).locator('input[data-key="channel-b"]').uncheck();
  expect(await pixel(page, 100, 30)).toEqual([255, 224, 0, 255]);
  await confirmDialog(page);
  expect(await prop(page, 'Tones', 'blending')).toMatchObject({ channels: { r: false, g: true, b: false } });
  expect(errors).toEqual([]);
});

test('a group takes a drop shadow; a brush dab next to it does not run its styles again', async ({ page }) => {
  const errors = await openApp(page);
  await build(page, {
    layers: [
      { name: 'Side', color: '#ff0000', x: 150, y: 10, w: 40, h: 40 },
      { name: 'Group', group: true },
      { name: 'A', color: '#0000ff', x: 20, y: 20, w: 40, h: 40, parent: 'Group' },
      { name: 'B', color: '#00ff00', x: 50, y: 50, w: 40, h: 40, parent: 'Group' },
    ],
  });
  await select(page, 'Group');
  expect(await enabled(page, 'layer:style')).toBe(true);
  await run(page, 'layer:style', 'dropShadow');
  await expect(dialog(page)).toBeVisible();
  await page.locator('.style-list [data-style="dropShadow"] input').check();
  for (const [k, v] of [['size', 0], ['distance', 10], ['angle', 90], ['opacity', 100]]) {
    await pane(page).locator(`input[type="number"][data-key="${k}"]`).fill(String(v));
    await pane(page).locator(`input[type="number"][data-key="${k}"]`).dispatchEvent('change');
  }
  await pane(page).locator('select[data-key="blend"]').selectOption('normal');
  await confirmDialog(page);
  // the group's whole content casts one shadow: under A's bottom edge and under B's
  expect(await pixel(page, 30, 65)).toEqual([0, 0, 0, 255]);
  expect(await pixel(page, 70, 95)).toEqual([0, 0, 0, 255]);
  // where A overlaps B's shadow area the content wins
  expect(await pixel(page, 55, 55)).toEqual([0, 255, 0, 255]);
  expect(await pixel(page, 30, 75)).toEqual([255, 255, 255, 255]);
  // a dab on the side layer repaints a rect: the group's styles are not run again
  const runs = await page.evaluate(async () => {
    const app = window.pigmentApp;
    const d = app.doc;
    const comp = d.view.compositor;
    comp.composite(d);
    const before = comp.styleRuns;
    const side = d.layers().find((l) => l.name === 'Side');
    side.canvas.getContext('2d').fillRect(5, 5, 4, 4);
    side.touch();
    d.changed('pixels', { layer: side, rect: { x: 155, y: 15, width: 4, height: 4 } });
    comp.composite(d, { rect: { x: 140, y: 0, width: 60, height: 60 } });
    comp.composite(d, { rect: { x: 40, y: 40, width: 60, height: 60 } });
    return comp.styleRuns - before;
  });
  expect(runs).toBe(0);
  // a pass-through group keeps passing through while its effects are off
  await page.evaluate(() => {
    const g = window.pigmentApp.doc.layers().find((l) => l.name === 'Group');
    g.styles = { dropShadow: { ...g.styles.dropShadow, enabled: false } };
    g.touch();
  });
  expect(await pixel(page, 30, 65)).toEqual([255, 255, 255, 255]);
  expect(errors).toEqual([]);
});

test('Hide All Effects hides every effect without removing them; Show All Effects brings them back', async ({ page }) => {
  const errors = await openApp(page);
  await build(page, { layers: [{ name: 'Box', color: '#0000ff', x: 60, y: 40, w: 60, h: 50, styles: { dropShadow: { enabled: true, size: 0, distance: 10, angle: 90, opacity: 1, color: '#000000', blend: 'normal' } } }] });
  const n = await historyLength(page);
  expect(await pixel(page, 90, 95)).toEqual([0, 0, 0, 255]);
  expect(await page.evaluate(() => window.pigmentApp.uiState.effectsHidden)).toBe(false);
  await runAwait(page, 'layer:style-toggle-all');
  expect(await pixel(page, 90, 95)).toEqual([255, 255, 255, 255]);
  expect(await prop(page, 'Box', 'styles')).toMatchObject({ hidden: true, dropShadow: { enabled: true } });
  expect(await page.evaluate(() => window.pigmentApp.uiState.effectsHidden)).toBe(true);
  expect(await historyLength(page)).toBe(n + 1);
  await runAwait(page, 'layer:style-toggle-all');
  expect(await pixel(page, 90, 95)).toEqual([0, 0, 0, 255]);
  expect((await prop(page, 'Box', 'styles')).hidden).toBeUndefined();
  await runAwait(page, 'edit:undo');
  expect((await prop(page, 'Box', 'styles')).hidden).toBe(true);
  await runAwait(page, 'edit:undo');
  expect((await prop(page, 'Box', 'styles')).hidden).toBeUndefined();
  // a layer without effects: the command is disabled
  await page.evaluate(() => window.pigmentApp.doc.setActive(window.pigmentApp.doc.root.children[0]));
  expect(await enabled(page, 'layer:style-toggle-all')).toBe(false);
  expect(errors).toEqual([]);
});

test('Scale Effects 50 % halves the sizes and distances of two shadows; Cancel leaves them', async ({ page }) => {
  const errors = await openApp(page);
  await build(page, { layers: [{ name: 'Box', color: '#0000ff', x: 60, y: 40, w: 60, h: 50, styles: { dropShadow: [{ enabled: true, size: 10, distance: 20, spread: 4 }, { enabled: true, size: 6, distance: 8 }] } }] });
  await run(page, 'layer:style-scale');
  await expect(page.locator('.dialog-backdrop')).toBeVisible();
  const field = page.locator('.dialog-backdrop input[type="number"][data-key="scale"]');
  await field.fill('50');
  await field.dispatchEvent('change');
  // live preview
  await expect.poll(async () => (await prop(page, 'Box', 'styles')).dropShadow.map((s) => s.size)).toEqual([5, 3]);
  await page.locator('.dialog-backdrop .dialog-buttons [data-value="null"]').click();
  await expect(page.locator('.dialog-backdrop')).toHaveCount(0);
  expect((await prop(page, 'Box', 'styles')).dropShadow.map((s) => s.size)).toEqual([10, 6]);
  const n = await historyLength(page);
  await run(page, 'layer:style-scale');
  await field.fill('50');
  await field.dispatchEvent('change');
  await confirmDialog(page);
  const st = await prop(page, 'Box', 'styles');
  expect(st.dropShadow.map((s) => [s.size, s.distance])).toEqual([[5, 10], [3, 4]]);
  expect(st.dropShadow[0].spread).toBe(2);
  expect(await historyLength(page)).toBe(n + 1);
  await runAwait(page, 'edit:undo');
  expect((await prop(page, 'Box', 'styles')).dropShadow.map((s) => s.size)).toEqual([10, 6]);
  // a recorded step applies without the dialog
  await runAwait(page, 'layer:style-scale', { scale: 200 });
  expect((await prop(page, 'Box', 'styles')).dropShadow.map((s) => s.size)).toEqual([20, 12]);
  expect(errors).toEqual([]);
});

test('Create Layers turns a drop shadow into a layer below and a colour overlay into a clipped layer above', async ({ page }) => {
  const errors = await openApp(page);
  await build(page, { layers: [{ name: 'Box', color: '#0000ff', x: 60, y: 40, w: 60, h: 50, styles: {
    dropShadow: { enabled: true, size: 0, distance: 10, angle: 90, opacity: 1, color: '#000000', blend: 'normal' },
    colorOverlay: { enabled: true, color: '#00ff00', opacity: 1, blend: 'normal' },
  } }] });
  const before = await page.evaluate(() => {
    const d = window.pigmentApp.doc;
    return Array.from(d.view.compositor.composite(d).getContext('2d').getImageData(0, 0, 200, 160).data);
  });
  const n = await historyLength(page);
  await runAwait(page, 'layer:style-create-layers');
  const tree = await page.evaluate(() => window.pigmentApp.doc.root.children.map((l) => ({ name: l.name, clip: l.clip, blend: l.blend, styles: l.styles })));
  expect(tree.map((l) => l.name)).toEqual(['Background', "Box's Drop Shadow", 'Box', "Box's Color Fill"]);
  expect(tree[1].clip).toBe(false);
  expect(tree[3].clip).toBe(true);
  expect(tree[2].styles).toBeNull();
  expect(await page.evaluate(() => window.pigmentApp.doc.active.name)).toBe('Box');
  // the picture is the same
  const after = await page.evaluate(() => {
    const d = window.pigmentApp.doc;
    return Array.from(d.view.compositor.composite(d).getContext('2d').getImageData(0, 0, 200, 160).data);
  });
  let worst = 0;
  for (let i = 0; i < after.length; i++) worst = Math.max(worst, Math.abs(after[i] - before[i]));
  expect(worst).toBeLessThanOrEqual(2);
  expect(await pixel(page, 90, 95)).toEqual([0, 0, 0, 255]);
  expect(await pixel(page, 90, 60)).toEqual([0, 255, 0, 255]);
  // one undo step
  expect(await historyLength(page)).toBe(n + 1);
  await runAwait(page, 'edit:undo');
  const undone = await page.evaluate(() => window.pigmentApp.doc.root.children.map((l) => l.name));
  expect(undone).toEqual(['Background', 'Box']);
  expect(await prop(page, 'Box', 'styles')).toMatchObject({ dropShadow: { enabled: true } });
  expect(errors).toEqual([]);
});

test('Blending Options edits are undone by Cancel and recorded by OK in one entry', async ({ page }) => {
  const errors = await openApp(page);
  await build(page, { layers: [{ name: 'Box', color: '#0000ff', x: 60, y: 40, w: 60, h: 50 }] });
  const n = await historyLength(page);
  await run(page, 'layer:style', 'dialog');
  await expect(dialog(page)).toBeVisible();
  await pane(page).locator('select[data-key="knockout"]').selectOption('shallow');
  await pane(page).locator('input[data-key="channel-g"]').uncheck();
  await pane(page).locator('input[data-key="interiorAsGroup"]').check();
  await pane(page).locator('input[type="number"][data-key="opacity"]').fill('50');
  await pane(page).locator('input[type="number"][data-key="opacity"]').dispatchEvent('change');
  // live on the layer
  expect(await prop(page, 'Box', 'blending')).toMatchObject({ knockout: 'shallow', channels: { g: false }, interiorAsGroup: true });
  expect(await prop(page, 'Box', 'opacity')).toBe(0.5);
  await page.locator('.style-dialog .dialog-buttons [data-value="null"]').click();
  await expect(dialog(page)).toHaveCount(0);
  expect(await prop(page, 'Box', 'blending')).toBeNull();
  expect(await prop(page, 'Box', 'opacity')).toBe(1);
  expect(await historyLength(page)).toBe(n);
  // OK records one entry; the check boxes come back as they were set
  await run(page, 'layer:style', 'dialog');
  await expect(dialog(page)).toBeVisible();
  await pane(page).locator('input[data-key="clippedAsGroup"]').uncheck();
  await pane(page).locator('input[data-key="maskHidesEffects"]').check();
  await pane(page).locator('input[data-key="vectorMaskHidesEffects"]').check();
  await pane(page).locator('input[data-key="transparencyShapes"]').uncheck();
  await confirmDialog(page);
  expect(await historyLength(page)).toBe(n + 1);
  expect(await prop(page, 'Box', 'blending')).toMatchObject({ clippedAsGroup: false, maskHidesEffects: true, vectorMaskHidesEffects: true, transparencyShapes: false });
  await run(page, 'layer:style', 'dialog');
  await expect(dialog(page)).toBeVisible();
  await expect(pane(page).locator('input[data-key="clippedAsGroup"]')).not.toBeChecked();
  await expect(pane(page).locator('input[data-key="maskHidesEffects"]')).toBeChecked();
  // back to the defaults: the layer stores null again
  await pane(page).locator('input[data-key="clippedAsGroup"]').check();
  await pane(page).locator('input[data-key="maskHidesEffects"]').uncheck();
  await pane(page).locator('input[data-key="vectorMaskHidesEffects"]').uncheck();
  await pane(page).locator('input[data-key="transparencyShapes"]').check();
  await confirmDialog(page);
  expect(await prop(page, 'Box', 'blending')).toBeNull();
  await runAwait(page, 'edit:undo');
  expect(await prop(page, 'Box', 'blending')).toMatchObject({ clippedAsGroup: false });
  await runAwait(page, 'edit:undo');
  expect(await prop(page, 'Box', 'blending')).toBeNull();
  expect(errors).toEqual([]);
});

test('Layer Mask Hides Effects; Blend Clipped Layers as Group off; Blend Interior Effects as Group', async ({ page }) => {
  const errors = await openApp(page);
  const features = await page.evaluate(async () => (await import('/shared/pixels/styles.js')).STYLE_FEATURES);
  await build(page, { layers: [
    { name: 'Box', color: '#0000ff', x: 60, y: 40, w: 60, h: 50, styles: { stroke: { enabled: true, size: 6, position: 'outside', color: '#000000', opacity: 1, blend: 'normal' } } },
  ] });
  // a mask hiding the right half of the box: the stroke follows the mask edge, until the mask hides the effects
  await page.evaluate(() => {
    const d = window.pigmentApp.doc;
    const l = d.layers().find((x) => x.name === 'Box');
    const m = document.createElement('canvas');
    m.width = d.width;
    m.height = d.height;
    const g = m.getContext('2d');
    g.fillStyle = '#fff';
    g.fillRect(0, 0, 90, d.height);
    l.mask = { canvas: m, enabled: true, linked: true };
    l.touch();
  });
  // x 92: just right of the mask edge, inside the box: the stroke drawn along the masked edge
  expect(await pixel(page, 92, 60)).toEqual([0, 0, 0, 255]);
  await page.evaluate(() => {
    const l = window.pigmentApp.doc.layers().find((x) => x.name === 'Box');
    l.blending = { maskHidesEffects: true };
    l.touch();
  });
  expect(await pixel(page, 92, 60)).toEqual([255, 255, 255, 255]);
  // the outside stroke on the left edge stays
  expect(await pixel(page, 57, 60)).toEqual([0, 0, 0, 255]);

  // Blend Clipped Layers as Group off: a Multiply layer clipped to a Screen base multiplies the backdrop directly
  await page.evaluate(async () => {
    const d = window.pigmentApp.doc;
    const { RasterLayer, createCanvas } = await import('/lib/document.js');
    const box = d.layers().find((x) => x.name === 'Box');
    box.styles = null;
    box.mask = null;
    box.blending = null;
    box.touch();
    const c = createCanvas(200, 160);
    const g = c.getContext('2d');
    g.fillStyle = '#808080';
    g.fillRect(0, 0, 200, 160);
    const clip = new RasterLayer({ name: 'Clip', canvas: c, x: 0, y: 0, blend: 'multiply', clip: true });
    d.add(clip, d.root, d.root.children.length);
  });
  // as a group (default): the clipped grey multiplies the blue base inside it -> dark blue over white
  const grouped = await pixel(page, 90, 60);
  expect(near(grouped, [0, 0, 128, 255])).toBe(true);
  await page.evaluate(() => {
    const box = window.pigmentApp.doc.layers().find((x) => x.name === 'Box');
    box.fillOpacity = 0;
    box.blending = { clippedAsGroup: false };
    box.touch();
  });
  // not as a group, with the base's fill at 0: the grey multiplies the white backdrop inside the base's shape only
  expect(near(await pixel(page, 90, 60), [128, 128, 128, 255])).toBe(true);
  expect(await pixel(page, 30, 30)).toEqual([255, 255, 255, 255]);

  // Blend Interior Effects as Group: a colour overlay fades with the fill (styles.js interiorAsGroup)
  if (!features.interiorAsGroup) {
    test.info().annotations.push({ type: 'skip', description: 'waits for layer-style-effects (STYLE_FEATURES.interiorAsGroup)' });
  } else {
    await page.evaluate(() => {
      const d = window.pigmentApp.doc;
      d.remove(d.layers().find((x) => x.name === 'Clip'));
      const box = d.layers().find((x) => x.name === 'Box');
      box.fillOpacity = 0;
      box.blending = null;
      box.styles = { colorOverlay: { enabled: true, color: '#00ff00', opacity: 1, blend: 'normal' } };
      box.touch();
    });
    expect(await pixel(page, 90, 60)).toEqual([0, 255, 0, 255]);
    await page.evaluate(() => {
      const box = window.pigmentApp.doc.layers().find((x) => x.name === 'Box');
      box.blending = { interiorAsGroup: true };
      box.touch();
    });
    expect(await pixel(page, 90, 60)).toEqual([255, 255, 255, 255]);
  }
  expect(errors).toEqual([]);
});

test('the Background takes no styles once its rules lock them; adjustment layers never do', async ({ page }) => {
  const errors = await openApp(page);
  await build(page, { layers: [{ name: 'Box', color: '#0000ff', x: 60, y: 40, w: 60, h: 50 }] });
  const r = await page.evaluate(async () => {
    const app = window.pigmentApp;
    const d = app.doc;
    const bg = d.root.children[0];
    const { isStyleable } = await import('/lib/blending-options.js');
    await app.commands.run('layer:new-adjustment', 'invert', 'api');
    const adj = d.layers().find((l) => l.type === 'adjustment');
    return { locks: app.backgroundRules.lockedProps(bg).includes('styles'), bg: isStyleable(bg, app), adj: adj ? isStyleable(adj, app) : false, box: isStyleable(d.layers().find((l) => l.name === 'Box'), app) };
  });
  expect(r.adj).toBe(false);
  expect(r.box).toBe(true);
  // the stub rules lock nothing until finish-layer-menu lands
  if (r.locks) expect(r.bg).toBe(false);
  else test.info().annotations.push({ type: 'skip', description: 'waits for finish-layer-menu (app.backgroundRules.lockedProps)' });
  expect(errors).toEqual([]);
});
