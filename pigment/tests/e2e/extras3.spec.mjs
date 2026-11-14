// Layer, Select and File extras (lib/layers-extras.js): Background from Layer / Layer from Background,
// Group from Layers, Delete Hidden Layers, per-layer export, Link / Select Linked, Rasterize All,
// Convert to Layers, colour labels, Deselect / Find / Isolate Layers, Open as Smart Object, Close
// Others, Purge, File Info and the Perspective Crop tool.
import { test, expect } from '@playwright/test';
import { openApp, newDoc, run, runAwait, pixel, drag, confirmDialog, historyLength, screenPoint } from './helpers.mjs';

/** Adds a raster layer on top with one filled rectangle; it becomes the active layer. Returns its id. */
const addRect = (page, name, color, x, y, w, h) =>
  page.evaluate(async ([n, c, rx, ry, rw, rh]) => {
    const app = window.pigmentApp;
    const { RasterLayer } = await import('/lib/document.js');
    const { structural } = await import('/lib/layer-ops.js');
    const d = app.doc;
    const layer = new RasterLayer({ name: n, width: d.width, height: d.height });
    const ctx = layer.canvas.getContext('2d');
    ctx.fillStyle = c;
    ctx.fillRect(rx, ry, rw, rh);
    structural(app, `Add ${n}`, () => {
      d.add(layer, d.root, d.root.children.length);
      d.setActive(layer);
    });
    return layer.id;
  }, [name, color, x, y, w, h]);

/** Selects layers by name (the last one becomes the active layer). */
const selectLayers = (page, names) =>
  page.evaluate((list) => {
    const d = window.pigmentApp.doc;
    const layers = list.map((n) => d.layers().find((l) => l.name === n));
    d.selected = new Set(layers);
    d.active = layers[layers.length - 1];
    d.changed('active', { layer: d.active });
  }, names);

const layerNames = (page) => page.evaluate(() => window.pigmentApp.doc.layers().map((l) => l.name));
/** Names of the rows the Layers panel shows, top to bottom (smart filter rows excluded). */
const panelRows = async (page) => {
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  return page.locator('[data-panel="layers"] .layer-list > .layer-row:not(.smart-filter-head):not(.smart-filter-row) .layer-name').allTextContents();
};
const uiState = (page) => page.evaluate(() => ({ ...window.__pigmentTest.uiState }));
const undo = (page) => page.evaluate(() => window.pigmentApp.doc.history.undo());

/** RGBA the canvas view actually shows at a document point (after the next paint). */
const viewPixel = (page, x, y) =>
  page.evaluate(async ([px, py]) => {
    const v = window.pigmentApp.view;
    v.invalidate();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const p = v.toScreen(px, py);
    return Array.from(v.canvas.getContext('2d').getImageData(Math.round(p.x * v.dpr), Math.round(p.y * v.dpr), 1, 1).data);
  }, [x, y]);

const fillDialog = async (page, values) => {
  await expect(page.locator('.dialog-backdrop .dialog')).toBeVisible();
  for (const [key, value] of Object.entries(values)) {
    const el = page.locator(`.dialog-backdrop [data-key="${key}"]`).first();
    if ((await el.evaluate((n) => n.tagName)) === 'SELECT') await el.selectOption(String(value));
    else await el.fill(String(value));
  }
};

test('Layer from Background asks for a name; Background from Layer flattens onto the background colour', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  expect((await uiState(page)).backgroundLayer).toBe(true);
  // Layer from Background: dialog with name, colour label, mode and opacity
  await run(page, 'layer:from-background');
  await expect(page.locator('.dialog-backdrop .dialog-title, .dialog-backdrop h2').first()).toContainText('New Layer');
  await fillDialog(page, { name: 'Base', color: 'green', opacity: 80 });
  await confirmDialog(page);
  let s = await page.evaluate(() => {
    const l = window.pigmentApp.doc.active;
    return { name: l.name, color: l.color, opacity: l.opacity, locked: l.locked, bg: window.pigmentApp.isBackgroundLayer(l) };
  });
  expect(s).toEqual({ name: 'Base', color: 'green', opacity: 0.8, locked: { pixels: false, position: false, transparency: false, all: false }, bg: false });
  await expect.poll(async () => (await uiState(page)).backgroundLayer).toBe(false);
  expect(await historyLength(page)).toBe(1);
  await undo(page);
  expect(await page.evaluate(() => [window.pigmentApp.doc.active.name, window.pigmentApp.doc.active.opacity, window.pigmentApp.doc.active.color ?? null])).toEqual(['Background', 1, null]);
  await page.evaluate(() => window.pigmentApp.doc.history.redo());

  // Background from Layer: the active layer goes to the bottom, opaque, on the background colour
  await addRect(page, 'Dot', '#ff0000', 100, 100, 50, 50);
  await page.evaluate(() => window.pigmentApp.setColors({ background: '#00ff00' }));
  const before = await historyLength(page);
  await runAwait(page, 'layer:from-background');
  s = await page.evaluate(() => {
    const d = window.pigmentApp.doc;
    const l = d.root.children[0];
    const px = (x, y) => Array.from(l.canvas.getContext('2d').getImageData(x, y, 1, 1).data);
    return { names: d.layers().map((x) => x.name), active: d.active === l, locked: l.locked, inside: px(120, 120), outside: px(10, 10), bg: window.pigmentApp.isBackgroundLayer(l) };
  });
  expect(s.names).toEqual(['Background', 'Base']);
  expect(s.active).toBe(true);
  expect(s.bg).toBe(true);
  expect(s.locked).toMatchObject({ position: true, transparency: true, all: false });
  expect(s.inside).toEqual([255, 0, 0, 255]);
  expect(s.outside).toEqual([0, 255, 0, 255]);
  expect(await historyLength(page)).toBe(before + 1);
  // with a Background in place another layer cannot become one: the command says so and changes nothing
  await selectLayers(page, ['Base']);
  await runAwait(page, 'layer:from-background');
  await expect(page.locator('#toasts .toast', { hasText: 'already has a Background' })).toBeVisible();
  expect(await layerNames(page)).toEqual(['Background', 'Base']);
  expect(await historyLength(page)).toBe(before + 1);
  await undo(page);
  expect(await layerNames(page)).toEqual(['Base', 'Dot']);
  expect(errors).toEqual([]);
});

test('Group from Layers names the group and tints its row; colour labels come from the eye menu', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  await runAwait(page, 'window:panel-layers');
  await addRect(page, 'One', '#ff0000', 10, 10, 40, 40);
  await addRect(page, 'Two', '#0000ff', 60, 10, 40, 40);
  await addRect(page, 'Three', '#00aa00', 110, 10, 40, 40);
  await selectLayers(page, ['One', 'Three']);
  const before = await historyLength(page);
  await run(page, 'layer:group-from-layers');
  await fillDialog(page, { name: 'Buttons', color: 'red', opacity: 50 });
  await confirmDialog(page);
  const s = await page.evaluate(() => {
    const d = window.pigmentApp.doc;
    const g = d.active;
    return { type: g.type, name: g.name, color: g.color, opacity: g.opacity, blend: g.blend, kids: g.children.map((c) => c.name), root: d.root.children.map((c) => c.name) };
  });
  expect(s).toEqual({ type: 'group', name: 'Buttons', color: 'red', opacity: 0.5, blend: 'pass-through', kids: ['One', 'Three'], root: ['Background', 'Two', 'Buttons'] });
  expect(await historyLength(page)).toBe(before + 1);
  await expect(page.locator('[data-panel="layers"] .layer-row[data-color="red"] .layer-name')).toHaveText('Buttons');

  // the colour label menu sits on the eye (right-click), like Photoshop
  await selectLayers(page, ['Two']);
  await page.locator('[data-panel="layers"] .layer-row', { hasText: 'Two' }).locator('.eye').click({ button: 'right' });
  await expect(page.locator('.popover .popover-item')).toHaveCount(8);
  await page.locator('.popover .popover-item', { hasText: 'Blue' }).click();
  await expect(page.locator('[data-panel="layers"] .layer-row[data-color="blue"] .layer-name')).toHaveText('Two');
  expect(await page.evaluate(() => window.pigmentApp.doc.active.color)).toBe('blue');
  await undo(page);
  await expect(page.locator('[data-panel="layers"] .layer-row[data-color="blue"]')).toHaveCount(0);
  await undo(page);
  expect(await layerNames(page)).toEqual(['Background', 'One', 'Two', 'Three']);
  expect(errors).toEqual([]);
});

test('Delete Hidden Layers confirms with the count and is one undo step', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  await addRect(page, 'Keep', '#ff0000', 10, 10, 40, 40);
  await addRect(page, 'Gone 1', '#0000ff', 60, 10, 40, 40);
  await addRect(page, 'Gone 2', '#00aa00', 110, 10, 40, 40);
  // nothing hidden: the command says so, asks nothing and deletes nothing
  await runAwait(page, 'layer:delete-hidden');
  await expect(page.locator('#toasts .toast', { hasText: 'no hidden layers' })).toBeVisible();
  await expect(page.locator('.dialog-backdrop')).toHaveCount(0);
  await page.evaluate(() => {
    for (const l of window.pigmentApp.doc.layers()) if (l.name.startsWith('Gone')) l.visible = false;
    window.pigmentApp.doc.changed('props');
  });
  const before = await historyLength(page);
  await run(page, 'layer:delete-hidden');
  await expect(page.locator('.dialog-backdrop .dialog-message')).toHaveText('Delete 2 hidden layers?');
  // Cancel deletes nothing
  await page.locator('.dialog-backdrop .dialog-buttons .btn', { hasText: 'Cancel' }).click();
  expect(await layerNames(page)).toEqual(['Background', 'Keep', 'Gone 1', 'Gone 2']);
  await run(page, 'layer:delete-hidden');
  await confirmDialog(page);
  expect(await layerNames(page)).toEqual(['Background', 'Keep']);
  expect(await historyLength(page)).toBe(before + 1);
  await undo(page);
  expect(await layerNames(page)).toEqual(['Background', 'Keep', 'Gone 1', 'Gone 2']);
  expect(errors).toEqual([]);
});

test('Quick Export and Export As write each selected layer alone, trimmed to its content', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  await addRect(page, 'Red box', '#ff0000', 20, 30, 50, 40);
  await addRect(page, 'Blue/box', '#0000ff', 200, 100, 30, 30);
  await addRect(page, 'Empty', '#000000', 0, 0, 0, 0);
  await selectLayers(page, ['Red box', 'Blue/box', 'Empty']);
  const size = (path) =>
    page.evaluate(async (p) => {
      const bytes = window.__pigmentTest.written[p];
      if (!bytes) return null;
      const bmp = await createImageBitmap(new Blob([bytes]));
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      c.getContext('2d').drawImage(bmp, 0, 0);
      const px = Array.from(c.getContext('2d').getImageData(Math.floor(bmp.width / 2), Math.floor(bmp.height / 2), 1, 1).data);
      return { w: bmp.width, h: bmp.height, px, magic: [bytes[0], bytes[1]] };
    }, path);

  // an unsaved document has no folder of its own: Quick Export asks for one
  await page.evaluate(() => (window.__pigmentTest.nextDirectory = 'browser:/out'));
  const paths = await runAwait(page, 'layer:export-quick');
  expect(paths).toEqual(['browser:/out/Blue_box.png', 'browser:/out/Red box.png']); // top layer first
  expect(await size('browser:/out/Red box.png')).toEqual({ w: 50, h: 40, px: [255, 0, 0, 255], magic: [0x89, 0x50] });
  expect(await size('browser:/out/Blue_box.png')).toEqual({ w: 30, h: 30, px: [0, 0, 255, 255], magic: [0x89, 0x50] });
  expect(await page.evaluate(() => Object.keys(window.__pigmentTest.written).length)).toBe(2);

  // Export As: the Export As fields, then a folder; JPEG at 200%
  await selectLayers(page, ['Red box']);
  await page.evaluate(() => (window.__pigmentTest.nextDirectory = 'browser:/exports'));
  await run(page, 'layer:export-as');
  await fillDialog(page, { format: 'jpeg', scale: 2 });
  await expect(page.locator('.dialog-backdrop [data-key="quality"]').first()).toBeVisible();
  await confirmDialog(page);
  await expect.poll(() => size('browser:/exports/Red box.jpg')).toMatchObject({ w: 100, h: 80, magic: [0xff, 0xd8] });
  // nothing of this is an edit
  expect(await page.evaluate(() => window.pigmentApp.doc.history.entries.map((e) => e.label))).toEqual(['Add Red box', 'Add Blue/box', 'Add Empty']);

  // a saved document: Quick Export writes next to it and never replaces a file that is already there
  await page.evaluate(() => {
    window.pigmentApp.doc.path = 'browser:/out/Test.pigment';
    window.pigmentApp.doc.path = '/project/Test.pigment';
    window.__pigmentTest.nextDirectory = null;
  });
  expect(await runAwait(page, 'layer:export-quick')).toEqual(['/project/Red box.png']);
  expect(await runAwait(page, 'layer:export-quick')).toEqual(['/project/Red box (2).png']);
  expect(errors).toEqual([]);
});

test('Link Layers: linked layers move together, Select Linked Layers, unlink, and links survive a .pigment round trip', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  await runAwait(page, 'window:panel-layers');
  await page.evaluate(() => (window.pigmentApp.settings.snap = false));
  await addRect(page, 'A', '#ff0000', 40, 40, 40, 40);
  await addRect(page, 'B', '#0000ff', 200, 40, 40, 40);
  await addRect(page, 'C', '#00aa00', 300, 200, 40, 40);
  // one layer alone cannot be linked: nothing changes, a note says why
  await selectLayers(page, ['A']);
  await runAwait(page, 'layer:link');
  await expect(page.locator('#toasts .toast', { hasText: 'two or more layers' })).toBeVisible();
  expect(await page.evaluate(() => window.pigmentApp.doc.active.linked ?? null)).toBeNull();
  expect(await historyLength(page)).toBe(3);
  await selectLayers(page, ['A', 'B']);
  const before = await historyLength(page);
  await runAwait(page, 'layer:link');
  const links = () => page.evaluate(() => Object.fromEntries(window.pigmentApp.doc.layers().map((l) => [l.name, l.linked ?? null])));
  let l = await links();
  expect(l.A).toBeTruthy();
  expect(l.B).toBe(l.A);
  expect(l.C).toBeNull();
  expect(await historyLength(page)).toBe(before + 1);
  await expect(page.locator('[data-panel="layers"] .layer-row[data-linked] .layer-name')).toHaveText(['B', 'A']);
  await expect(page.locator('[data-panel="layers"] .panel-footer [data-cmd="layer:link"]')).toBeVisible();

  // dragging A with the Move tool moves B too, as one undo step; C stays
  await selectLayers(page, ['A']);
  await page.evaluate(() => window.pigmentApp.tools.activate('move'));
  await drag(page, [60, 60], [100, 85]);
  const pos = () => page.evaluate(() => Object.fromEntries(window.pigmentApp.doc.layers().map((x) => [x.name, [x.x, x.y]])));
  let p = await pos();
  expect(Math.abs(p.A[0] - 40)).toBeLessThanOrEqual(1);
  expect(Math.abs(p.A[1] - 25)).toBeLessThanOrEqual(1);
  expect(p.B).toEqual(p.A);
  expect(p.C).toEqual([0, 0]);
  expect(await pixel(page, 200 + p.B[0] + 20, 40 + p.B[1] + 20)).toEqual([0, 0, 255, 255]);
  expect(await historyLength(page)).toBe(before + 2);
  // arrow keys nudge the linked layers together as well
  await page.keyboard.press('ArrowRight');
  const n = await pos();
  expect(n.A[0]).toBe(p.A[0] + 1);
  expect(n.B[0]).toBe(p.B[0] + 1);
  await undo(page);
  await undo(page);
  p = await pos();
  expect([p.A, p.B]).toEqual([[0, 0], [0, 0]]);

  // Select Linked Layers picks the whole set
  await runAwait(page, 'layer:select-linked');
  expect(await page.evaluate(() => window.pigmentApp.doc.selectedLayers().map((x) => x.name).sort())).toEqual(['A', 'B']);

  // save and reopen: links and colour labels are kept
  await runAwait(page, 'layer:color', 'violet');
  const reopened = await page.evaluate(async () => {
    const app = window.pigmentApp;
    const { writePigment, readPigment } = await import('/lib/io.js');
    const doc = await readPigment(await writePigment(app.doc));
    app.docs.add(doc);
    return Object.fromEntries(doc.layers().map((x) => [x.name, [x.linked ?? null, x.color ?? null]]));
  });
  expect(reopened.A[0]).toBe(l.A);
  expect(reopened.B).toEqual([l.A, 'violet']);
  expect(reopened.A[1]).toBe('violet');
  expect(reopened.C).toEqual([null, null]);
  await page.evaluate(() => window.pigmentApp.docs.close(window.pigmentApp.doc, { force: true }));

  // a third layer joins the set; one linked layer alone leaves it; the last pair dissolves the set
  await selectLayers(page, ['A', 'C']);
  await runAwait(page, 'layer:link');
  l = await links();
  expect([l.B, l.C]).toEqual([l.A, l.A]);
  await selectLayers(page, ['C']);
  expect(await page.evaluate(() => window.pigmentApp.commands.isChecked('layer:link'))).toBe(true);
  await runAwait(page, 'layer:link');
  l = await links();
  expect(l.C).toBeNull();
  expect(l.B).toBe(l.A);
  await selectLayers(page, ['A']);
  await runAwait(page, 'layer:link');
  l = await links();
  expect([l.A, l.B, l.C]).toEqual([null, null, null]);
  await expect(page.locator('[data-panel="layers"] .layer-row[data-linked]')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('Rasterize All Layers turns type, shape, fill and smart layers into pixels without changing the picture', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  await page.evaluate(async () => {
    const app = window.pigmentApp;
    const { TextLayer, ShapeLayer, FillLayer, AdjustmentLayer, GroupLayer } = await import('/lib/document.js');
    const { ellipsePath } = await import('/lib/tools/vector.js');
    const { structural } = await import('/lib/layer-ops.js');
    const d = app.doc;
    structural(app, 'Build', () => {
      const g = new GroupLayer({ name: 'Group' });
      d.add(new FillLayer({ name: 'Fill', paint: { type: 'solid', color: '#204080' }, opacity: 0.5 }), d.root, 1);
      d.add(new ShapeLayer({ name: 'Circle', path: ellipsePath(40, 40, 120, 120), fill: { type: 'solid', color: '#ff0000' } }), d.root, 2);
      d.add(g, d.root, 3);
      d.add(new TextLayer({ name: 'Title', text: 'Hello', x: 200, y: 100, font: { family: 'Arial', size: 60, color: '#000000' } }), g, 0);
      d.add(new AdjustmentLayer({ name: 'Invert', kind: 'invert', params: {} }), d.root, 4);
      d.setActive(d.layers().find((l) => l.name === 'Title'));
    });
  });
  await selectLayers(page, ['Title']);
  await runAwait(page, 'layer:smart-convert');
  const snapshot = () =>
    page.evaluate(() => {
      const d = window.pigmentApp.doc;
      const c = d.view.compositor.composite(d);
      const data = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let sum = 0;
      for (let i = 0; i < data.length; i += 4) sum += data[i] + data[i + 1] * 3 + data[i + 2] * 7;
      return sum;
    });
  const picture = await snapshot();
  const types = () => page.evaluate(() => window.pigmentApp.doc.layers().map((l) => `${l.name}:${l.type}`));
  expect(await types()).toEqual(['Background:raster', 'Fill:fill', 'Circle:shape', 'Group:group', 'Title:smart', 'Invert:adjustment']);
  const before = await historyLength(page);
  await runAwait(page, 'layer:rasterize-all');
  expect(await types()).toEqual(['Background:raster', 'Fill:raster', 'Circle:raster', 'Group:group', 'Title:raster', 'Invert:adjustment']);
  expect(await page.evaluate(() => window.pigmentApp.doc.active.name)).toBe('Title');
  expect(await snapshot()).toBe(picture);
  expect(await historyLength(page)).toBe(before + 1);
  // a second run finds nothing left to rasterize and records nothing
  expect(await runAwait(page, 'layer:rasterize-all')).toBe(0);
  expect(await historyLength(page)).toBe(before + 1);
  await undo(page);
  expect(await types()).toEqual(['Background:raster', 'Fill:fill', 'Circle:shape', 'Group:group', 'Title:smart', 'Invert:adjustment']);
  expect(await snapshot()).toBe(picture);
  expect(errors).toEqual([]);
});

test('Convert to Layers unpacks a smart object through its transform', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  await addRect(page, 'Red', '#ff0000', 100, 80, 60, 40);
  await addRect(page, 'Blue', '#0000ff', 130, 100, 60, 40);
  await selectLayers(page, ['Red', 'Blue']);
  await runAwait(page, 'layer:smart-convert');
  expect(await page.evaluate(() => window.pigmentApp.commands.isEnabled('layer:smart-to-layers'))).toBe(true);
  // halve the object, move it, and give it an opacity the group has to carry
  await page.evaluate(async () => {
    const app = window.pigmentApp;
    const { setLayerProps } = await import('/lib/layer-ops.js');
    const l = app.doc.active;
    setLayerProps(app, l, { transform: [0.5, 0, 0, 0.5, 100, 80], opacity: 0.5 }, 'Scale');
  });
  // the source is the 400 × 300 canvas: red lands on (150,120)-(180,140), blue on (165,130)-(195,150)
  const sample = async () => [await pixel(page, 155, 125), await pixel(page, 172, 135), await pixel(page, 188, 145), await pixel(page, 50, 50), await pixel(page, 160, 145)];
  const close = (got, want) => got.every((v, i) => Math.abs(v - want[i]) <= 3);
  const picture = await sample();
  expect(close(picture[0], [255, 128, 128, 255]), `red at 50% over white, got ${picture[0]}`).toBe(true);
  expect(close(picture[1], [128, 128, 255, 255]), `blue covers red inside the object before the opacity applies, got ${picture[1]}`).toBe(true);
  expect(close(picture[2], [128, 128, 255, 255])).toBe(true);
  expect(picture[4]).toEqual([255, 255, 255, 255]);
  const before = await historyLength(page);
  await runAwait(page, 'layer:smart-to-layers');
  const s = await page.evaluate(() => {
    const d = window.pigmentApp.doc;
    const g = d.active;
    return { type: g.type, opacity: g.opacity, blend: g.blend, kids: g.children.map((c) => [c.name, c.type, c.x, c.y, c.canvas.width, c.canvas.height]), smart: d.layers().some((l) => l.type === 'smart') };
  });
  expect(s.type).toBe('group');
  expect(s.opacity).toBe(0.5);
  expect(s.blend).toBe('normal');
  expect(s.smart).toBe(false);
  expect(s.kids.map((k) => k.slice(0, 2))).toEqual([['Red', 'raster'], ['Blue', 'raster']]);
  // the layers were resampled through the matrix: half the size, at the object's place
  expect(s.kids[0].slice(2)).toEqual([100, 80, 200, 150]);
  const unpacked = await sample();
  unpacked.forEach((px, i) => expect(close(px, picture[i]), `sample ${i}: ${px} vs ${picture[i]}`).toBe(true));
  expect(await historyLength(page)).toBe(before + 1);
  await undo(page);
  expect(await page.evaluate(() => window.pigmentApp.doc.active.type)).toBe('smart');
  expect(await sample()).toEqual(picture);

  // an image source becomes one raster layer; smart filters are announced before they are dropped
  await page.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 40;
    c.height = 20;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#00ff00';
    ctx.fillRect(0, 0, 40, 20);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    window.__pigmentTest.files['browser:/green.png'] = new Uint8Array(await blob.arrayBuffer());
  });
  await runAwait(page, 'file:place', 'browser:/green.png');
  await page.evaluate(() => {
    const l = window.pigmentApp.doc.active;
    l.filters = [{ kind: 'invert', params: {}, enabled: true }];
    l.touch();
  });
  await run(page, 'layer:smart-to-layers');
  await expect(page.locator('.dialog-backdrop .dialog-message')).toContainText('loses its smart filters');
  await confirmDialog(page);
  const img = await page.evaluate(() => {
    const l = window.pigmentApp.doc.active;
    return { type: l.type, name: l.name, w: l.canvas.width, h: l.canvas.height, x: l.x, y: l.y };
  });
  expect(img).toEqual({ type: 'raster', name: 'green', w: 40, h: 20, x: 180, y: 140 });
  expect(await pixel(page, 200, 150)).toEqual([0, 255, 0, 255]);
  expect(errors).toEqual([]);
});

test('Deselect Layers leaves no layer targeted and tools cope with that', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  await runAwait(page, 'window:panel-layers');
  await addRect(page, 'One', '#ff0000', 10, 10, 40, 40);
  await runAwait(page, 'select:deselect-layers');
  expect(await page.evaluate(() => [window.pigmentApp.doc.active, window.pigmentApp.doc.selected.size])).toEqual([null, 0]);
  await expect(page.locator('[data-panel="layers"] .layer-row.selected, [data-panel="layers"] .layer-row.active')).toHaveCount(0);
  expect(await page.evaluate(() => window.pigmentApp.commands.isEnabled('select:deselect-layers'))).toBe(false);
  expect((await uiState(page)).hasLayer).toBe(false);
  // painting, moving and panels with nothing selected raise no errors and change nothing
  for (const tool of ['brush', 'move', 'eraser']) {
    await page.evaluate((t) => window.pigmentApp.tools.activate(t), tool);
    await drag(page, [100, 100], [160, 140]);
  }
  for (const id of ['properties', 'channels', 'history', 'layers']) await runAwait(page, `window:panel-${id}`);
  expect(await historyLength(page)).toBe(1);
  // clicking a row targets a layer again
  await page.locator('[data-panel="layers"] .layer-row', { hasText: 'One' }).locator('.layer-name').click();
  expect(await page.evaluate(() => window.pigmentApp.doc.active?.name)).toBe('One');
  expect(errors).toEqual([]);
});

test('Find Layers filters the Layers panel by name, kind, attribute, mode, effect and colour', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  await page.evaluate(async () => {
    const app = window.pigmentApp;
    const { RasterLayer, TextLayer, ShapeLayer, AdjustmentLayer, GroupLayer } = await import('/lib/document.js');
    const { ellipsePath } = await import('/lib/tools/vector.js');
    const { structural } = await import('/lib/layer-ops.js');
    const d = app.doc;
    const painted = (name) => {
      const l = new RasterLayer({ name, width: d.width, height: d.height });
      l.canvas.getContext('2d').fillRect(10, 10, 20, 20);
      return l;
    };
    structural(app, 'Build', () => {
      const g = new GroupLayer({ name: 'Scenery' });
      d.add(painted('Sky'), d.root, 1);
      d.add(new TextLayer({ name: 'Title', text: 'Hello', x: 20, y: 20, font: { family: 'Arial', size: 30, color: '#000000' } }), d.root, 2);
      d.add(new ShapeLayer({ name: 'Box', path: ellipsePath(40, 40, 60, 60), fill: { type: 'solid', color: '#ff0000' } }), d.root, 3);
      d.add(g, d.root, 4);
      d.add(painted('Inner sky'), g, 0);
      d.add(new RasterLayer({ name: 'Blank', width: d.width, height: d.height }), g, 1);
      d.add(new AdjustmentLayer({ name: 'Curves', kind: 'invert', params: {}, visible: false }), d.root, 5);
      const sky = d.layers().find((l) => l.name === 'Sky');
      sky.blend = 'multiply';
      sky.color = 'yellow';
      sky.styles = { dropShadow: { enabled: true, blend: 'multiply', color: '#000000', opacity: 0.75, angle: 120, distance: 5, spread: 0, size: 5 } };
      d.layers().find((l) => l.name === 'Box').locked.position = true;
      d.setActive(sky);
    });
  });
  const all = ['Curves', 'Scenery', 'Blank', 'Inner sky', 'Box', 'Title', 'Sky', 'Background'];
  expect(await panelRows(page)).toEqual(all);
  await expect(page.locator('.layer-filter-bar')).toBeHidden();

  // the menu command: the bar appears, searching by name with the cursor in the field
  await runAwait(page, 'select:find-layers');
  await expect(page.locator('.layer-filter-bar')).toBeVisible();
  await expect(page.locator('.layer-filter-bar [data-filter-type]')).toHaveValue('name');
  await expect(page.locator('.layer-filter-bar input[data-filter-value="name"]')).toBeFocused();
  await page.keyboard.type('SKY');
  await expect.poll(() => panelRows(page)).toEqual(['Scenery', 'Inner sky', 'Sky']);
  expect(await page.evaluate(() => window.pigmentApp.tools.active.id)).toBe('move'); // S, K and Y went to the field, not to the tool shortcuts

  // by kind: toggles add up; groups show for what they hold
  await page.locator('.layer-filter-bar [data-filter-type]').selectOption('kind');
  expect(await panelRows(page)).toEqual(all); // no kind chosen yet: nothing is hidden
  await page.locator('.layer-filter-kind[data-kind="type"]').click();
  expect(await panelRows(page)).toEqual(['Title']);
  await page.locator('.layer-filter-kind[data-kind="shape"]').click();
  expect(await panelRows(page)).toEqual(['Box', 'Title']);
  await page.locator('.layer-filter-kind[data-kind="type"]').click();
  await page.locator('.layer-filter-kind[data-kind="shape"]').click();
  await page.locator('.layer-filter-kind[data-kind="pixel"]').click();
  expect(await panelRows(page)).toEqual(['Scenery', 'Blank', 'Inner sky', 'Sky', 'Background']);
  await page.locator('.layer-filter-kind[data-kind="pixel"]').click();
  await page.locator('.layer-filter-kind[data-kind="adjustment"]').click();
  expect(await panelRows(page)).toEqual(['Curves']);

  // the switch turns filtering off and on again without losing the filter
  await page.locator('.layer-filter-bar [data-filter-switch]').click();
  expect(await panelRows(page)).toEqual(all);
  await expect(page.locator('.layer-filter-bar [data-filter-switch]')).toHaveAttribute('aria-checked', 'false');
  await page.locator('.layer-filter-bar [data-filter-switch]').click();
  expect(await panelRows(page)).toEqual(['Curves']);

  // attributes, blend mode, effect and colour label
  const filtered = async (patch) => {
    await page.evaluate((p) => window.pigmentApp.commands.run('select:find-layers', p), patch);
    return panelRows(page);
  };
  expect(await filtered({ type: 'attribute', attribute: 'hidden' })).toEqual(['Curves']);
  expect(await filtered({ type: 'attribute', attribute: 'locked' })).toEqual(['Box']);
  expect(await filtered({ type: 'attribute', attribute: 'empty' })).toEqual(['Scenery', 'Blank']);
  expect(await filtered({ type: 'attribute', attribute: 'effects' })).toEqual(['Sky']);
  expect(await filtered({ type: 'mode', mode: 'multiply' })).toEqual(['Sky']);
  expect(await filtered({ type: 'mode', mode: 'pass-through' })).toEqual(['Scenery']);
  expect(await filtered({ type: 'effect', effect: 'dropShadow' })).toEqual(['Sky']);
  expect(await filtered({ type: 'effect', effect: 'stroke' })).toEqual([]);
  expect(await filtered({ type: 'color', color: 'yellow' })).toEqual(['Sky']);
  await expect(page.locator('.layer-filter-bar select[data-filter-value="color"]')).toHaveValue('yellow');

  // closing the bar shows everything; filtering never touched the document
  await page.locator('.layer-filter-bar [data-filter-close]').click();
  await expect(page.locator('.layer-filter-bar')).toBeHidden();
  expect(await panelRows(page)).toEqual(all);
  expect(await historyLength(page)).toBe(1);
  expect(errors).toEqual([]);
});

test('Isolate Layers shows only the selected layers in the panel and on the canvas, without editing the document', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  await runAwait(page, 'window:panel-layers');
  await addRect(page, 'Red', '#ff0000', 40, 40, 80, 80);
  await addRect(page, 'Blue', '#0000ff', 240, 40, 80, 80);
  await selectLayers(page, ['Red']);
  const before = await historyLength(page);
  expect(await viewPixel(page, 280, 80)).toEqual([0, 0, 255, 255]);
  expect((await uiState(page)).isolated).toBe(false);

  await runAwait(page, 'select:isolate-layers');
  expect((await uiState(page)).isolated).toBe(true);
  expect(await page.evaluate(() => window.pigmentApp.commands.isChecked('select:isolate-layers'))).toBe(true);
  expect(await panelRows(page)).toEqual(['Red']);
  await expect(page.locator('.layer-isolation-bar')).toBeVisible();
  await expect(page.locator('.layer-isolation-bar .layer-isolation-text')).toHaveText('Isolation mode: 1 layer shown');
  // on the canvas: red is there, blue and the white background are not (the checkerboard shows through)
  expect(await viewPixel(page, 80, 80)).toEqual([255, 0, 0, 255]);
  const where = await viewPixel(page, 280, 80);
  expect(where[2] - where[0]).toBeLessThan(40); // not blue
  expect(where[0]).toBe(where[1]); // a grey or white checker square
  // the document itself is untouched: exports and saves still see every layer
  expect(await pixel(page, 280, 80)).toEqual([0, 0, 255, 255]);
  expect(await page.evaluate(() => window.pigmentApp.doc.layers().every((l) => l.visible))).toBe(true);
  expect(await historyLength(page)).toBe(before);

  // a layer made while isolated joins the isolation (it would vanish as it is created)
  await addRect(page, 'Green', '#00ff00', 150, 200, 40, 40);
  expect(await panelRows(page)).toEqual(['Green', 'Red']);
  expect(await viewPixel(page, 170, 220)).toEqual([0, 255, 0, 255]);
  // painting on an isolated layer shows at once
  await page.evaluate(() => {
    const l = window.pigmentApp.doc.layers().find((x) => x.name === 'Red');
    const ctx = l.canvas.getContext('2d');
    ctx.fillStyle = '#ffff00';
    ctx.fillRect(40, 40, 20, 20);
    l.touch();
  });
  expect(await viewPixel(page, 50, 50)).toEqual([255, 255, 0, 255]);

  // leaving isolation (the Exit button of the strip) brings everything back
  await page.locator('.layer-isolation-bar [data-isolation-exit]').click();
  expect((await uiState(page)).isolated).toBe(false);
  expect(await panelRows(page)).toEqual(['Green', 'Blue', 'Red', 'Background']);
  expect(await viewPixel(page, 280, 80)).toEqual([0, 0, 255, 255]);
  await expect(page.locator('.layer-isolation-bar')).toBeHidden();

  // isolation belongs to its document; deleting the isolated layers ends it
  await selectLayers(page, ['Blue']);
  await runAwait(page, 'select:isolate-layers');
  await newDoc(page, { name: 'Other' });
  expect((await uiState(page)).isolated).toBe(false);
  await runAwait(page, 'view:prev-tab');
  expect((await uiState(page)).isolated).toBe(true);
  expect(await panelRows(page)).toEqual(['Blue']);
  await runAwait(page, 'layer:delete');
  expect((await uiState(page)).isolated).toBe(false);
  expect(await panelRows(page)).toEqual(['Green', 'Red', 'Background']);
  expect(errors).toEqual([]);
});

test('Open as Smart Object, Close Others and Purge', async ({ page }) => {
  const errors = await openApp(page);
  await page.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 120;
    c.height = 80;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ff8800';
    ctx.fillRect(0, 0, 120, 80);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    window.__pigmentTest.files['browser:/photo.png'] = new Uint8Array(await blob.arrayBuffer());
    window.__pigmentTest.nextOpenFiles = ['browser:/photo.png', '/fixtures/layers.psd'];
  });
  // each file opens as its own document holding one smart object (a layered file keeps its layers inside)
  await runAwait(page, 'file:open-smart');
  const docs = await page.evaluate(() => window.pigmentApp.docs.docs.map((d) => ({ name: d.name, w: d.width, h: d.height, path: d.path, dirty: d.history.dirty, layers: d.layers().map((l) => [l.name, l.type, l.source?.kind]) })));
  expect(docs[0]).toEqual({ name: 'photo', w: 120, h: 80, path: null, dirty: false, layers: [['photo', 'smart', 'image']] });
  expect(docs[1]).toMatchObject({ name: 'layers', path: null, dirty: false, layers: [['layers', 'smart', 'document']] });
  expect(docs[1].w).toBeGreaterThan(1);
  await runAwait(page, 'view:prev-tab');
  expect(await pixel(page, 60, 40)).toEqual([255, 136, 0, 255]);

  // into the active document on request
  await newDoc(page, { name: 'Host' });
  await runAwait(page, 'file:open-smart', { paths: ['browser:/photo.png'], into: 'active' });
  expect(await page.evaluate(() => [window.pigmentApp.doc.name, window.pigmentApp.doc.active.type, window.pigmentApp.doc.layers().length])).toEqual(['Host', 'smart', 2]);

  // Close Others keeps only the active document (it has unsaved changes; the others have none, so nothing asks)
  expect(await page.evaluate(() => window.pigmentApp.docs.docs.length)).toBe(3);
  expect(await runAwait(page, 'file:close-others')).toBe(true);
  expect(await page.evaluate(() => window.pigmentApp.docs.docs.map((d) => d.name))).toEqual(['Host']);
  expect(await page.evaluate(() => window.pigmentApp.commands.isEnabled('file:close-others'))).toBe(false);

  // Purge › Undo: the history goes, the document stays as it is and stays "edited"
  await addRect(page, 'One', '#ff0000', 10, 10, 40, 40);
  await addRect(page, 'Two', '#0000ff', 60, 10, 40, 40);
  await undo(page);
  expect(await page.evaluate(() => [window.pigmentApp.doc.history.entries.length, window.pigmentApp.doc.history.canRedo])).toEqual([3, true]);
  await run(page, 'edit:purge', 'undo');
  await expect(page.locator('.dialog-backdrop .dialog-message')).toHaveText('Purge the undo history of this document?');
  await confirmDialog(page);
  const purged = await page.evaluate(() => {
    const h = window.pigmentApp.doc.history;
    return { entries: h.entries.length, undo: h.canUndo, redo: h.canRedo, dirty: h.dirty, names: window.pigmentApp.doc.layers().map((l) => l.name) };
  });
  expect(purged).toEqual({ entries: 0, undo: false, redo: false, dirty: true, names: ['Background', 'photo', 'One'] });
  expect((await uiState(page)).canUndo).toBe(false);
  // editing goes on normally afterwards
  await addRect(page, 'Three', '#00aa00', 110, 10, 40, 40);
  await undo(page);
  expect(await layerNames(page)).toEqual(['Background', 'photo', 'One']);

  // Purge › Clipboard / Histories / All
  await runAwait(page, 'select:all');
  await runAwait(page, 'edit:copy');
  expect(await page.evaluate(() => !!window.pigmentApp.clipboard)).toBe(true);
  await newDoc(page, { name: 'Second' });
  await addRect(page, 'X', '#ff0000', 10, 10, 40, 40);
  expect(await runAwait(page, 'edit:purge', { what: 'clipboard', confirm: false })).toEqual({ steps: 0, clipboard: true });
  expect(await page.evaluate(() => window.pigmentApp.clipboard)).toBeNull();
  const all = await runAwait(page, 'edit:purge', { what: 'all', confirm: false });
  expect(all.steps).toBeGreaterThanOrEqual(2);
  expect(await page.evaluate(() => window.pigmentApp.docs.docs.map((d) => d.history.entries.length))).toEqual([0, 0]);
  // Cancel in the question purges nothing; Histories clears every open document
  await addRect(page, 'Y', '#ff0000', 10, 10, 40, 40);
  await run(page, 'edit:purge', 'histories');
  await expect(page.locator('.dialog-backdrop .dialog-message')).toHaveText('Purge the undo histories of all open documents?');
  await page.locator('.dialog-backdrop .dialog-buttons .btn', { hasText: 'Cancel' }).click();
  expect(await historyLength(page)).toBe(1);
  await runAwait(page, 'view:prev-tab');
  await addRect(page, 'Z', '#ff0000', 10, 10, 40, 40);
  await run(page, 'edit:purge', 'histories');
  await confirmDialog(page);
  expect(await page.evaluate(() => window.pigmentApp.docs.docs.map((d) => [d.history.entries.length, d.history.dirty]))).toEqual([[0, true], [0, true]]);
  expect(errors).toEqual([]);
});

test('File Info stores keywords, rating, credit, source and copyright in the document and shows camera data', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  await run(page, 'file:properties');
  await expect(page.locator('.dialog-backdrop .dialog')).toContainText('File Info');
  await expect(page.locator('.dialog-backdrop .file-info-camera')).toHaveCount(0);
  await fillDialog(page, { title: 'Harbour at dawn', author: 'A. Painter', description: 'Boats & gulls', keywords: 'harbour; boats, Harbour ;dawn', credit: 'Studio North', source: 'Scan', copyrightStatus: 'copyrighted', copyright: '© 2026 A. Painter', copyrightUrl: 'not a url', dpi: 300 });
  await page.locator('.dialog-backdrop .file-info-rating button[data-star="4"]').click();
  await expect(page.locator('.dialog-backdrop .file-info-rating button.on')).toHaveCount(4);
  // a copyright URL that is no web address keeps the dialog open
  await page.locator('.dialog-backdrop .dialog-buttons .btn.primary').click();
  await expect(page.locator('.dialog-backdrop .dialog')).toBeVisible();
  await fillDialog(page, { copyrightUrl: 'https://example.com/rights' });
  await confirmDialog(page);
  const expected = { title: 'Harbour at dawn', author: 'A. Painter', description: 'Boats & gulls', keywords: ['harbour', 'boats', 'dawn'], rating: 4, credit: 'Studio North', source: 'Scan', copyrightStatus: 'copyrighted', copyright: '© 2026 A. Painter', copyrightUrl: 'https://example.com/rights' };
  expect(await page.evaluate(() => ({ ...window.pigmentApp.doc.meta }))).toEqual(expected);
  expect(await page.evaluate(() => window.pigmentApp.doc.dpi)).toBe(300);
  expect(await historyLength(page)).toBe(1);
  expect(await page.evaluate(() => window.pigmentApp.doc.history.entries[0].label)).toBe('File info');

  // the XMP packet other formats carry, and a .pigment round trip
  const round = await page.evaluate(async () => {
    const app = window.pigmentApp;
    const info = await import('/lib/file-info.js');
    const { writePigment, readPigment } = await import('/lib/io.js');
    const packet = info.xmpPacket(app.doc.meta);
    const doc = await readPigment(await writePigment(app.doc));
    return { packet, parsed: info.parseXmp(packet), meta: doc.meta };
  });
  expect(round.packet).toContain('<dc:subject><rdf:Bag><rdf:li>harbour</rdf:li><rdf:li>boats</rdf:li><rdf:li>dawn</rdf:li></rdf:Bag></dc:subject>');
  expect(round.packet).toContain('Boats &amp; gulls');
  expect(round.parsed).toEqual(expected);
  expect(round.meta).toEqual(expected);

  // OK without a change records nothing; undo takes the fields away again
  await run(page, 'file:properties');
  await expect(page.locator('.dialog-backdrop [data-key="keywords"]')).toHaveValue('harbour; boats; dawn');
  await expect(page.locator('.dialog-backdrop .file-info-rating button.on')).toHaveCount(4);
  await confirmDialog(page);
  expect(await historyLength(page)).toBe(1);
  await undo(page);
  expect(await page.evaluate(() => [window.pigmentApp.doc.meta.title ?? '', window.pigmentApp.doc.meta.keywords ?? [], window.pigmentApp.doc.dpi])).toEqual(['', [], 72]);

  // camera data of a photograph is shown, read-only
  await page.evaluate(() => {
    const d = window.pigmentApp.doc;
    d.meta = { ...d.meta, exif: { make: 'Canon', model: 'Canon EOS R5', lens: 'RF 50mm F1.8', exposureTime: 1 / 250, fNumber: 2.8, iso: 400, focalLength: 50, flash: 16, dateTimeOriginal: '2026:03:14 08:15:00' } };
  });
  await run(page, 'file:properties');
  const camera = page.locator('.dialog-backdrop .file-info-camera');
  await expect(camera).toBeVisible();
  await expect(camera).toContainText('Canon EOS R5');
  await expect(camera).toContainText('1/250 s at f/2.8');
  await expect(camera).toContainText('2026-03-14 08:15:00');
  await expect(camera.locator('input, textarea, select')).toHaveCount(0);
  await page.locator('.dialog-backdrop .dialog-buttons .btn', { hasText: 'Cancel' }).click();
  expect(await page.evaluate(() => window.pigmentApp.doc.meta.exif.iso)).toBe(400);

  // a recorded step (actions) carries the fields and skips the dialog; saving as PSD writes them as XMP
  await runAwait(page, 'file:properties', { title: 'Replayed', keywords: 'one; two', rating: 5, copyrightStatus: 'public' });
  expect(await page.evaluate(() => [window.pigmentApp.doc.meta.title, window.pigmentApp.doc.meta.keywords, window.pigmentApp.doc.meta.rating])).toEqual(['Replayed', ['one', 'two'], 5]);
  await page.evaluate(() => (window.__pigmentTest.nextSavePath = 'browser:/saved.psd'));
  expect(await runAwait(page, 'file:save-as')).toBe(true);
  const saved = await page.evaluate(async () => {
    const info = await import('/lib/file-info.js');
    const { readPsd } = await import('ag-psd');
    const bytes = window.__pigmentTest.written['browser:/saved.psd'];
    const psd = readPsd(bytes, { skipThumbnail: true });
    return { fromResource: info.parseXmp(psd.imageResources.xmpMetadata), layers: psd.children.map((c) => c.name), size: [psd.width, psd.height], dpi: psd.imageResources.resolutionInfo.horizontalResolution };
  });
  expect(saved).toEqual({ fromResource: { title: 'Replayed', keywords: ['one', 'two'], rating: 5, copyrightStatus: 'public' }, layers: ['Background'], size: [400, 300], dpi: 72 });
  // and the saved PSD brings its File Info back when it is opened
  await page.evaluate(() => window.pigmentApp.docs.close(window.pigmentApp.doc, { force: true }));
  await runAwait(page, 'file:open-paths', ['browser:/saved.psd']);
  await expect.poll(() => page.evaluate(() => window.pigmentApp.doc?.meta?.title ?? null)).toBe('Replayed');
  expect(await page.evaluate(() => window.pigmentApp.doc.meta.keywords)).toEqual(['one', 'two']);
  expect(errors).toEqual([]);
});

test('Perspective Crop straightens a drawn trapezoid into a rectangle of the chosen size', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  // a red trapezoid with a blue dot where its diagonals cross (a perspective maps that point to the centre)
  const quad = [[100, 60], [300, 90], [330, 250], [70, 220]];
  await page.evaluate(async (q) => {
    const app = window.pigmentApp;
    const { RasterLayer } = await import('/lib/document.js');
    const { structural } = await import('/lib/layer-ops.js');
    const d = app.doc;
    const layer = new RasterLayer({ name: 'Sign', width: d.width, height: d.height });
    const ctx = layer.canvas.getContext('2d');
    ctx.fillStyle = '#ff0000';
    ctx.beginPath();
    q.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.fill();
    // intersection of the diagonals q0-q2 and q1-q3
    const [a, b, c, e] = q;
    const den = (a[0] - c[0]) * (b[1] - e[1]) - (a[1] - c[1]) * (b[0] - e[0]);
    const t = ((a[0] - b[0]) * (b[1] - e[1]) - (a[1] - b[1]) * (b[0] - e[0])) / den;
    const cx = a[0] + t * (c[0] - a[0]), cy = a[1] + t * (c[1] - a[1]);
    ctx.fillStyle = '#0000ff';
    ctx.beginPath();
    ctx.arc(cx, cy, 6, 0, Math.PI * 2);
    ctx.fill();
    structural(app, 'Add sign', () => {
      d.add(layer, d.root, d.root.children.length);
      d.setActive(layer);
    });
    d.guides = [{ axis: 'x', pos: 200 }];
  }, quad);
  await runAwait(page, 'tool:perspective-crop');
  expect(await page.evaluate(() => window.pigmentApp.tools.active.id)).toBe('perspective-crop');
  await expect(page.locator('#options-bar .options-title')).toContainText('Perspective Crop');
  for (const key of ['width', 'height', 'resolution', 'front', 'clear', 'showGrid']) await expect(page.locator(`#options-bar [data-key="${key}"]`)).toBeVisible();

  // Front Image takes the document's size and resolution, Clear empties the fields again
  await page.locator('#options-bar [data-key="front"] button').click();
  expect(await page.evaluate(() => ['width', 'height', 'resolution'].map((k) => window.pigmentApp.tools.active.opt(k)))).toEqual([400, 300, 72]);
  await page.locator('#options-bar [data-key="clear"] button').click();
  expect(await page.evaluate(() => ['width', 'height', 'resolution'].map((k) => window.pigmentApp.tools.active.opt(k)))).toEqual([0, 0, 0]);
  await page.locator('#options-bar [data-key="width"] input').fill('200');
  await page.locator('#options-bar [data-key="width"] input').press('Tab');
  await page.locator('#options-bar [data-key="height"] input').fill('150');
  await page.locator('#options-bar [data-key="height"] input').press('Tab');

  // drag a box, then pull its four corners onto the trapezoid
  await drag(page, [120, 100], [280, 200]);
  expect(await page.evaluate(() => window.pigmentApp.tools.active.complete)).toBe(true);
  const box = [[120, 100], [280, 100], [280, 200], [120, 200]];
  for (let i = 0; i < 4; i++) await drag(page, box[i], quad[i]);
  const placed = await page.evaluate(() => window.pigmentApp.tools.active.quad());
  for (let i = 0; i < 4; i++) {
    expect(Math.abs(placed[i][0] - quad[i][0])).toBeLessThanOrEqual(1);
    expect(Math.abs(placed[i][1] - quad[i][1])).toBeLessThanOrEqual(1);
  }
  expect(await page.evaluate(() => window.pigmentApp.tools.active.size())).toEqual({ width: 200, height: 150 });
  const before = await historyLength(page);
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => [window.pigmentApp.doc.width, window.pigmentApp.doc.height])).toEqual([200, 150]);
  await page.waitForFunction(() => !document.body.classList.contains('busy'));
  // the whole canvas is the red sign now: every corner region is red, the dot sits in the middle
  for (const [x, y] of [[6, 6], [193, 6], [193, 143], [6, 143], [100, 30], [40, 75], [160, 75], [100, 120]]) {
    const px = await pixel(page, x, y);
    expect(px[0], `red at ${x},${y}`).toBeGreaterThan(235);
    expect(px[1] + px[2], `red at ${x},${y}`).toBeLessThan(40);
  }
  const centre = await page.evaluate(() => {
    const d = window.pigmentApp.doc;
    const c = d.view.compositor.composite(d);
    const data = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0, sx = 0, sy = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i + 2] > 180 && data[i] < 80) {
      n++;
      sx += (i / 4) % c.width;
      sy += Math.floor(i / 4 / c.width);
    }
    return { n, x: sx / n, y: sy / n };
  });
  expect(centre.n).toBeGreaterThan(20);
  expect(Math.abs(centre.x - 100)).toBeLessThan(2.5);
  expect(Math.abs(centre.y - 75)).toBeLessThan(2.5);
  expect(await historyLength(page)).toBe(before + 1);
  expect(await page.evaluate(() => [window.pigmentApp.doc.history.entries.at(-1).label, window.pigmentApp.doc.guides.length, window.pigmentApp.doc.layers().length, window.pigmentApp.tools.active.points.length])).toEqual(['Perspective crop', 0, 2, 0]);

  // undo restores the document exactly
  await undo(page);
  expect(await page.evaluate(() => [window.pigmentApp.doc.width, window.pigmentApp.doc.height, window.pigmentApp.doc.guides.length])).toEqual([400, 300, 1]);
  expect(await pixel(page, 150, 120)).toEqual([255, 0, 0, 255]);
  expect(await pixel(page, 20, 20)).toEqual([255, 255, 255, 255]);
  expect(errors).toEqual([]);
});

test('Perspective Crop: clicked corners, Escape, a plain box keeps type editable, a perspective rasterizes it', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  await page.evaluate(async () => {
    const app = window.pigmentApp;
    const { TextLayer } = await import('/lib/document.js');
    const { structural } = await import('/lib/layer-ops.js');
    const d = app.doc;
    structural(app, 'Add text', () => {
      const t = new TextLayer({ name: 'Title', text: 'Hi', x: 150, y: 100, font: { family: 'Arial', size: 60, color: '#000000' } });
      d.add(t, d.root, 1);
      d.setActive(t);
    });
  });
  await runAwait(page, 'tool:perspective-crop');
  await page.locator('#options-bar [data-key="clear"] button').click();
  // four clicks in any order make the quad; Escape throws it away (and then belongs to the document again)
  for (const [x, y] of [[300, 220], [100, 80], [320, 60], [90, 240]]) {
    const p = await screenPoint(page, x, y);
    await page.mouse.click(p.x, p.y);
  }
  const clicked = await page.evaluate(() => window.pigmentApp.tools.active.quad());
  expect(clicked.map((p) => p.map(Math.round))).toEqual([[100, 80], [320, 60], [300, 220], [90, 240]]);
  await page.keyboard.press('Escape');
  expect(await page.evaluate(() => window.pigmentApp.tools.active.points.length)).toBe(0);
  // Enter with no quad does nothing
  await page.keyboard.press('Enter');
  expect(await historyLength(page)).toBe(1);

  // a plain box is an ordinary crop: nothing is resampled and the type layer stays type
  await page.evaluate(() => window.pigmentApp.tools.active.setQuad([[100, 50], [300, 50], [300, 250], [100, 250]]));
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => [window.pigmentApp.doc.width, window.pigmentApp.doc.height])).toEqual([200, 200]);
  await page.waitForFunction(() => !document.body.classList.contains('busy'));
  expect(await page.evaluate(() => window.pigmentApp.doc.layers().map((l) => l.type))).toEqual(['raster', 'text']);
  expect(await page.evaluate(() => window.pigmentApp.doc.layers()[1].x)).toBe(50);
  await undo(page);

  // a real perspective: the type layer is rasterized (and says so), the resolution option sets the dpi
  await page.evaluate(() => {
    const t = window.pigmentApp.tools.active;
    t.setOpt('resolution', 150);
    t.setQuad([[60, 40], [340, 70], [330, 260], [80, 220]]);
  });
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => window.pigmentApp.doc.dpi)).toBe(150);
  await page.waitForFunction(() => !document.body.classList.contains('busy'));
  expect(await page.evaluate(() => window.pigmentApp.doc.layers().map((l) => `${l.name}:${l.type}`))).toEqual(['Background:raster', 'Title:raster']);
  await expect(page.locator('#toasts .toast', { hasText: 'rasterized' })).toBeVisible();
  const dark = await page.evaluate(() => {
    const d = window.pigmentApp.doc;
    const c = d.view.compositor.composite(d);
    const data = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i] < 60 && data[i + 3] === 255) n++;
    return n;
  });
  expect(dark).toBeGreaterThan(300); // the text is still there, as pixels
  await undo(page);
  expect(await page.evaluate(() => [window.pigmentApp.doc.layers().map((l) => l.type), window.pigmentApp.doc.dpi, window.pigmentApp.doc.width])).toEqual([['raster', 'text'], 72, 400]);

  // a quad whose corners cross is refused
  await page.evaluate(() => window.pigmentApp.tools.active.setOpt('resolution', 0));
  const refused = await runAwait(page, 'image:perspective-crop', { quad: [[100, 100], [200, 100], [150, 110], [100, 200]] });
  expect(refused).toBe(false);
  expect(await page.evaluate(() => window.pigmentApp.doc.width)).toBe(400);
  expect(errors).toEqual([]);
});

test('opening a photograph fills in its camera data, opening a PSD its XMP File Info', async ({ page }) => {
  const errors = await openApp(page);
  await page.evaluate(async () => {
    // a real JPEG with an Exif segment (Make, Model) spliced in after the start-of-image marker
    const c = document.createElement('canvas');
    c.width = 64;
    c.height = 48;
    c.getContext('2d').fillRect(0, 0, 64, 48);
    const jpeg = new Uint8Array(await (await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9))).arrayBuffer());
    const ascii = (s) => [...s].map((ch) => ch.charCodeAt(0)).concat(0);
    const make = ascii('Fuji'), model = ascii('X-T5 ');
    const tiff = [0x49, 0x49, 42, 0, 8, 0, 0, 0, 2, 0, 0x0f, 0x01, 2, 0, make.length, 0, 0, 0, 38, 0, 0, 0, 0x10, 0x01, 2, 0, model.length, 0, 0, 0, 38 + make.length + 1, 0, 0, 0, 0, 0, 0, 0, ...make, 0, ...model];
    const body = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
    const seg = [0xff, 0xe1, (body.length + 2) >> 8, (body.length + 2) & 255, ...body];
    const out = new Uint8Array(jpeg.length + seg.length);
    out.set(jpeg.subarray(0, 2), 0);
    out.set(seg, 2);
    out.set(jpeg.subarray(2), 2 + seg.length);
    window.__pigmentTest.files['browser:/camera.jpg'] = out;

    // a PSD carrying a File Info packet in its image resources, written with the PSD library Pigment ships
    const { writePsdUint8Array } = await import('ag-psd');
    const { xmpPacket } = await import('/lib/file-info.js');
    const canvas = document.createElement('canvas');
    canvas.width = 20;
    canvas.height = 10;
    canvas.getContext('2d').fillRect(0, 0, 20, 10);
    window.__pigmentTest.files['browser:/info.psd'] = writePsdUint8Array({ width: 20, height: 10, children: [{ name: 'L', canvas, left: 0, top: 0 }], canvas, imageResources: { xmpMetadata: xmpPacket({ title: 'From Photoshop', keywords: ['a', 'b'], rating: 2, copyrightStatus: 'public' }) } }, {});
  });
  await runAwait(page, 'file:open-paths', ['browser:/camera.jpg']);
  await expect.poll(() => page.evaluate(() => window.pigmentApp.doc?.meta?.exif ?? null)).toEqual({ make: 'Fuji', model: 'X-T5' });
  expect(await page.evaluate(() => window.pigmentApp.doc.history.dirty)).toBe(false); // reading metadata is not an edit
  await run(page, 'file:properties');
  await expect(page.locator('.dialog-backdrop .file-info-camera')).toContainText('Fuji X-T5');
  await page.locator('.dialog-backdrop .dialog-buttons .btn', { hasText: 'Cancel' }).click();

  await runAwait(page, 'file:open-paths', ['browser:/info.psd']);
  await expect.poll(() => page.evaluate(() => window.pigmentApp.doc?.meta?.title ?? null)).toBe('From Photoshop');
  expect(await page.evaluate(() => ({ ...window.pigmentApp.doc.meta }))).toEqual({ title: 'From Photoshop', keywords: ['a', 'b'], rating: 2, copyrightStatus: 'public' });
  expect(errors).toEqual([]);
});
