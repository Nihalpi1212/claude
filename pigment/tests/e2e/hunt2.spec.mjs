// Regression tests for the second bug hunt (files, type and vector tools).
import { test, expect } from '@playwright/test';
import { openApp, newDoc, run, runAwait, openFixture, pixel, drag, confirmDialog, screenPoint, historyLength } from './helpers.mjs';

const click = async (page, x, y) => {
  const a = await screenPoint(page, x, y);
  await page.mouse.click(a.x, a.y);
};
const activate = (page, id) => page.evaluate((t) => window.pigmentApp.tools.activate(t), id);
const texts = (page) => page.evaluate(() => window.pigmentApp.doc.layers().filter((l) => l.type === 'text').map((l) => ({ name: l.name, text: l.text, width: l.width, x: l.x })));
const session = (page) => page.evaluate(() => !!window.pigmentApp.tools.active.session);
const saved = (page, path) => page.evaluate((p) => window.__pigmentTest.written[p] ?? null, path);

// ---- files ----

test('Save never overwrites a format Pigment cannot write; Save As to such a name writes a PNG', async ({ page }) => {
  const errors = await openApp(page);
  // a "GIF" (PNG bytes under a .gif name decode fine, only the extension matters here)
  await page.evaluate(async () => {
    const res = await fetch('/fixtures/gradient.png');
    window.__pigmentTest.files['mem:/pic.gif'] = new Uint8Array(await res.arrayBuffer());
  });
  await runAwait(page, 'file:open-paths', ['mem:/pic.gif']);
  await expect.poll(() => page.evaluate(() => window.pigmentApp.doc?.path)).toBe('mem:/pic.gif');
  await page.evaluate(() => {
    const l = window.pigmentApp.doc.active;
    l.canvas.getContext('2d').fillRect(0, 0, 5, 5);
    l.touch();
    window.pigmentApp.doc.changed('pixels', { layer: l });
    window.__pigmentTest.nextSavePath = 'mem:/typed.gif';
  });
  await runAwait(page, 'file:save'); // opens Save As (the dialog answers with the typed .gif name)
  await expect.poll(() => page.evaluate(() => Object.keys(window.__pigmentTest.written))).toEqual(['mem:/typed.png']);
  expect(await saved(page, 'mem:/pic.gif')).toBeNull();
  expect(Array.from((await saved(page, 'mem:/typed.png')).slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
  expect(await page.evaluate(() => [window.pigmentApp.doc.path, window.pigmentApp.doc.name])).toEqual(['mem:/typed.png', 'typed']);
  expect(errors).toEqual([]);
});

test('PSD keeps group masks, fill opacity, locks, adjustment layers and editable text', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { background: 'white' });
  await page.evaluate(async () => {
    const { RasterLayer, GroupLayer, TextLayer, AdjustmentLayer, createCanvas } = await import('/lib/document.js');
    const app = window.pigmentApp;
    const d = app.doc;
    const red = new RasterLayer({ name: 'Red', canvas: createCanvas(400, 300), x: 0, y: 0 });
    red.canvas.getContext('2d').fillStyle = '#ff0000';
    red.canvas.getContext('2d').fillRect(0, 0, 400, 300);
    red.fillOpacity = 0.6;
    red.locked.position = true;
    red.locked.transparency = true;
    const grp = new GroupLayer({ name: 'G' });
    const mask = createCanvas(400, 300);
    mask.getContext('2d').fillStyle = '#fff';
    mask.getContext('2d').fillRect(0, 0, 200, 300); // right half of the group hidden
    grp.mask = { canvas: mask, enabled: true, linked: true };
    const green = new RasterLayer({ name: 'Green', canvas: createCanvas(400, 300), x: 0, y: 0 });
    green.canvas.getContext('2d').fillStyle = '#00ff00';
    green.canvas.getContext('2d').fillRect(0, 0, 400, 300);
    const inv = new AdjustmentLayer({ name: 'Inv', kind: 'invert', params: {} });
    const hs = new AdjustmentLayer({ name: 'HS', kind: 'hue-saturation', params: { hue: 60, saturation: 10, lightness: -5, colorize: false, colorizeHue: 0, colorizeSat: 25, colorizeLight: 0, range: 'master' } });
    hs.visible = false;
    const txt = new TextLayer({ name: 'Txt', text: 'Hey', x: 20, y: 200, width: null, font: { family: 'Arial', size: 36, color: '#0000ff', weight: 700, italic: false, align: 'left', lineHeight: 1.2, letterSpacing: 0 } });
    const box = new TextLayer({ name: 'Box', text: 'boxed words here', x: 100, y: 100, width: 150, font: { family: 'Arial', size: 20, color: '#008000', weight: 400, align: 'center', lineHeight: 1.5 } });
    for (const l of [red, grp, inv, hs, txt, box]) d.add(l, d.root, d.root.children.length); // bottom to top
    grp.children.push(green);
    green.parent = grp;
    d.changed('tree');
    window.__pigmentTest.nextSavePath = 'mem:/rt.psd';
  });
  const before = await pixel(page, 50, 50);
  expect(before.slice(0, 3)).toEqual([255, 0, 255]); // green (inside the masked group) inverted
  await runAwait(page, 'file:save-as');
  await expect.poll(() => page.evaluate(() => window.__pigmentTest.written['mem:/rt.psd']?.length ?? 0)).toBeGreaterThan(1000);
  await page.evaluate(() => (window.__pigmentTest.files['mem:/rt2.psd'] = window.__pigmentTest.written['mem:/rt.psd']));
  await runAwait(page, 'file:open-paths', ['mem:/rt2.psd']);
  await expect.poll(() => page.evaluate(() => window.pigmentApp.doc.path)).toBe('mem:/rt2.psd');
  const info = await page.evaluate(() => {
    const d = window.pigmentApp.doc;
    const by = (n) => d.layers().find((l) => l.name === n);
    const g = by('G'), inv = by('Inv'), hs = by('HS'), red = by('Red'), txt = by('Txt'), box = by('Box');
    return {
      groupMask: !!g?.mask?.canvas && g.mask.enabled,
      maskLeft: g.mask.canvas.getContext('2d').getImageData(50, 50, 1, 1).data[3],
      maskRight: g.mask.canvas.getContext('2d').getImageData(300, 50, 1, 1).data[3],
      inv: [inv?.type, inv?.kind, inv?.parent === d.root, !!inv?.mask?.canvas],
      green: [by('Green')?.parent?.name],
      hs: [hs?.type, hs?.kind, hs?.params.hue, hs?.params.saturation, hs?.params.lightness, hs?.visible],
      red: [Math.round(red.fillOpacity * 100), red.locked.position, red.locked.transparency, red.locked.pixels],
      txt: [txt?.type, txt?.text, txt?.font.family, txt?.font.size, txt?.font.color, txt?.font.weight, txt?.width, Math.round(txt?.x), Math.round(txt?.y)],
      box: [box?.type, box?.text, box?.width, box?.font.align, box?.font.lineHeight, Math.round(box?.x), Math.round(box?.y)],
    };
  });
  expect(info.groupMask).toBe(true);
  expect(info.maskLeft).toBe(255);
  expect(info.maskRight).toBe(0);
  expect(info.inv).toEqual(['adjustment', 'invert', true, true]);
  expect(info.green).toEqual(['G']);
  expect(info.hs).toEqual(['adjustment', 'hue-saturation', 60, 10, -5, false]);
  expect(info.red).toEqual([60, true, true, false]);
  expect(info.txt).toEqual(['text', 'Hey', 'Arial', 36, '#0000ff', 700, null, 20, 200]);
  expect(info.box).toEqual(['text', 'boxed words here', 150, 'center', 1.5, 100, 100]);
  // the reopened stack composites like the original: inverted green on the left, inverted 60% red on the right of the group mask
  expect(await pixel(page, 50, 50)).toEqual(before);
  expect((await pixel(page, 300, 50)).slice(0, 3)).toEqual([0, 153, 153]);
  expect(errors).toEqual([]);
});

test('Revert keeps the document when the file cannot be read again', async ({ page }) => {
  const errors = await openApp(page);
  await page.evaluate(async () => {
    const res = await fetch('/fixtures/shapes.png');
    window.__pigmentTest.files['mem:/rv.png'] = new Uint8Array(await res.arrayBuffer());
  });
  await runAwait(page, 'file:open-paths', ['mem:/rv.png']);
  await expect.poll(() => page.evaluate(() => window.pigmentApp.doc?.path)).toBe('mem:/rv.png');
  await runAwait(page, 'image:adjust-invert');
  await expect.poll(() => page.evaluate(() => window.pigmentApp.doc.history.dirty)).toBe(true);
  await page.evaluate(() => {
    delete window.__pigmentTest.files['mem:/rv.png']; // the file is gone (drive unplugged, moved...)
  });
  await run(page, 'file:revert');
  await confirmDialog(page);
  await expect(page.locator('.toast.error')).toContainText('Could not revert');
  expect(await page.evaluate(() => [window.pigmentApp.docs.docs.length, window.pigmentApp.doc?.path, window.pigmentApp.doc?.history.dirty])).toEqual([1, 'mem:/rv.png', true]);
  // with the file back, Revert replaces the document in place
  await page.evaluate(async () => {
    const res = await fetch('/fixtures/shapes.png');
    window.__pigmentTest.files['mem:/rv.png'] = new Uint8Array(await res.arrayBuffer());
  });
  await run(page, 'file:revert');
  await confirmDialog(page);
  await expect.poll(() => page.evaluate(() => window.pigmentApp.doc?.history.dirty)).toBe(false);
  expect(await page.evaluate(() => [window.pigmentApp.docs.docs.length, window.pigmentApp.doc?.path])).toEqual([1, 'mem:/rv.png']);
  expect(errors.filter((e) => !/Could not revert|mem:\/rv\.png/.test(e))).toEqual([]);
});

test('saving a JPEG asks for its quality once and ignores the Export As quality', async ({ page }) => {
  const errors = await openApp(page);
  await openFixture(page, 'gradient.png');
  await page.evaluate(() => {
    window.pigmentApp.settings.exportDefaults = { format: 'jpeg', quality: 0.01, scale: 1 };
    window.__pigmentTest.nextSavePath = 'mem:/photo.jpg';
  });
  await run(page, 'file:save-as');
  await expect(page.locator('.dialog .dialog-header h2')).toHaveText('JPEG Options');
  await confirmDialog(page);
  await expect.poll(() => page.evaluate(() => window.__pigmentTest.written['mem:/photo.jpg']?.length ?? 0)).toBeGreaterThan(0);
  const first = await page.evaluate(() => window.__pigmentTest.written['mem:/photo.jpg'].length);
  // the second Save writes straight away with the same quality
  await page.evaluate(() => {
    const l = window.pigmentApp.doc.active;
    l.canvas.getContext('2d').fillRect(0, 0, 2, 2);
    l.touch();
    window.pigmentApp.doc.changed('pixels', { layer: l });
    delete window.__pigmentTest.written['mem:/photo.jpg'];
  });
  await runAwait(page, 'file:save');
  await expect(page.locator('.dialog-backdrop')).toHaveCount(0);
  const second = await page.evaluate(() => window.__pigmentTest.written['mem:/photo.jpg']?.length ?? 0);
  expect(second).toBeGreaterThan(first * 0.5);
  // 1% quality of the same image is far smaller: the Export As setting was not used
  const tiny = await page.evaluate(async () => {
    const { exportImage } = await import('/lib/io.js');
    const d = window.pigmentApp.doc;
    return (await exportImage(d, { format: 'jpeg', quality: 0.01 }, d.view.compositor)).length;
  });
  expect(first).toBeGreaterThan(tiny * 1.5);
  expect(errors).toEqual([]);
});

test('the status bar follows the resolution set in Document Properties (and its undo)', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  await run(page, 'file:properties');
  await page.locator('.dialog input[data-key="dpi"]').fill('300');
  await confirmDialog(page);
  await expect(page.locator('#statusbar')).toContainText('300 ppi');
  await runAwait(page, 'edit:undo');
  await expect(page.locator('#statusbar')).toContainText('72 ppi');
  expect(errors).toEqual([]);
});

// ---- type tool ----

test('Undo while typing does not throw the text session away', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  await activate(page, 'type-horizontal');
  await click(page, 50, 100);
  await page.keyboard.type('Two');
  await page.keyboard.press('Control+Enter');
  await expect.poll(() => texts(page)).toEqual([{ name: 'Two', text: 'Two', width: null, x: 50 }]);
  const entries = await historyLength(page);
  await click(page, 60, 95);
  await expect.poll(() => session(page)).toBe(true);
  await page.keyboard.press('End');
  await page.keyboard.type(' more');
  await expect.poll(() => texts(page)).toEqual([{ name: 'Two more', text: 'Two more', width: null, x: 50 }]);
  await page.evaluate(() => document.activeElement.blur());
  await runAwait(page, 'edit:undo');
  expect(await session(page)).toBe(true);
  expect(await historyLength(page)).toBe(entries);
  expect(await page.evaluate(() => window.pigmentApp.doc.layers().filter((l) => l.type === 'text').length)).toBe(1);
  await page.keyboard.press('Control+Enter');
  expect(await session(page)).toBe(false);
  expect(errors).toEqual([]);
});

test('rotating the image while typing commits the text first', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  await activate(page, 'type-horizontal');
  await click(page, 50, 100);
  await page.keyboard.type('Hello');
  await page.keyboard.press('Control+Enter');
  await click(page, 70, 95);
  await expect.poll(() => session(page)).toBe(true);
  await page.keyboard.press('End');
  await page.keyboard.type(' A');
  await runAwait(page, 'image:rotate-90');
  expect(await session(page)).toBe(false);
  await page.keyboard.type('B');
  const t = await texts(page);
  expect(t).toHaveLength(1);
  expect(t[0].text).toBe('Hello A');
  expect(await page.evaluate(() => [window.pigmentApp.doc.width, window.pigmentApp.doc.height])).toEqual([300, 400]);
  await runAwait(page, 'edit:undo'); // the rotation
  expect(await page.evaluate(() => [window.pigmentApp.doc.width, window.pigmentApp.doc.height])).toEqual([400, 300]);
  expect((await texts(page))[0].text).toBe('Hello A');
  expect(errors).toEqual([]);
});

test('paragraph box handles resize the box', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  await activate(page, 'type-horizontal');
  await drag(page, [150, 150], [300, 250]);
  await expect.poll(() => session(page)).toBe(true);
  await page.keyboard.type('box');
  const corner = await page.evaluate(() => {
    const l = window.pigmentApp.tools.active.session.layer;
    const lay = l.layout();
    return [l.x + l.width, l.y + Math.max(lay.height, lay.lineHeight)];
  });
  await drag(page, corner, [corner[0] + 50, corner[1]]);
  await expect.poll(() => texts(page)).toEqual([{ name: 'box', text: 'box', width: 200, x: 150 }]);
  expect(await session(page)).toBe(true);
  // the left edge moves the box instead of growing it to the right
  await drag(page, [150, 150], [170, 150]);
  await expect.poll(() => texts(page)).toEqual([{ name: 'box', text: 'box', width: 180, x: 170 }]);
  await page.keyboard.press('Control+Enter');
  await runAwait(page, 'edit:undo');
  await expect.poll(() => texts(page)).toEqual([]);
  await runAwait(page, 'edit:redo');
  await expect.poll(() => texts(page)).toEqual([{ name: 'box', text: 'box', width: 180, x: 170 }]);
  expect(errors).toEqual([]);
});

test('the type tool ignores text inside a hidden group', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  await activate(page, 'type-horizontal');
  await click(page, 50, 100);
  await page.keyboard.type('Ghost');
  await page.keyboard.press('Control+Enter');
  await runAwait(page, 'layer:group');
  await page.evaluate(() => {
    const d = window.pigmentApp.doc;
    const g = d.layers().find((l) => l.isGroup);
    g.visible = false;
    d.changed('props', { layer: g });
    d.setActive(d.layers()[0]);
  });
  await click(page, 60, 95);
  await expect.poll(() => session(page)).toBe(true);
  expect(await page.evaluate(() => window.pigmentApp.tools.active.session.isNew)).toBe(true);
  await page.keyboard.type('New');
  await page.keyboard.press('Control+Enter');
  expect((await texts(page)).map((t) => t.text).sort()).toEqual(['Ghost', 'New']);
  expect(errors).toEqual([]);
});

test('font changes on several text layers merge like they do on one', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  await activate(page, 'type-horizontal');
  await click(page, 50, 100);
  await page.keyboard.type('One');
  await page.keyboard.press('Control+Enter');
  await click(page, 50, 220);
  await page.keyboard.type('Two');
  await page.keyboard.press('Control+Enter');
  const n = await historyLength(page);
  await page.evaluate(async () => {
    const { applyTypeStyle } = await import('/lib/tools/text.js');
    const d = window.pigmentApp.doc;
    for (const l of d.layers()) if (l.type === 'text') d.selected.add(l);
    applyTypeStyle(window.pigmentApp, { color: '#00ff00' }, { label: 'Character', merge: true });
    applyTypeStyle(window.pigmentApp, { color: '#0000ff' }, { label: 'Character', merge: true });
  });
  expect(await historyLength(page)).toBe(n + 1);
  const colors = () => page.evaluate(() => window.pigmentApp.doc.layers().filter((l) => l.type === 'text').map((l) => l.font.color));
  expect(await colors()).toEqual(['#0000ff', '#0000ff']);
  await runAwait(page, 'edit:undo');
  expect(await colors()).toEqual(['#000000', '#000000']);
  await runAwait(page, 'edit:redo');
  expect(await colors()).toEqual(['#0000ff', '#0000ff']);
  expect(errors).toEqual([]);
});

// ---- pen tools ----

test('the pen ignores a repeated click on the last anchor and Add Anchor Point ignores anchors', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  await activate(page, 'pen-tool');
  await page.evaluate(() => window.pigmentApp.tools.setOpt('pen-tool', 'mode', 'path'));
  await click(page, 100, 100);
  await click(page, 200, 100);
  await click(page, 200, 100);
  await click(page, 200, 200);
  await page.keyboard.press('Enter');
  const points = () => page.evaluate(() => window.pigmentApp.doc.workPath.subpaths[0].points.map((p) => [p.x, p.y]));
  await expect.poll(points).toEqual([[100, 100], [200, 100], [200, 200]]);
  const n = await historyLength(page);
  await activate(page, 'pen-add');
  await click(page, 200, 100); // an existing anchor: nothing to add
  expect(await points()).toEqual([[100, 100], [200, 100], [200, 200]]);
  expect(await historyLength(page)).toBe(n);
  await click(page, 150, 100); // the middle of a segment
  await expect.poll(points).toEqual([[100, 100], [150, 100], [200, 100], [200, 200]]);
  expect(await historyLength(page)).toBe(n + 1);
  expect(errors).toEqual([]);
});
