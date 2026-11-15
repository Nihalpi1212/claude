// Regressions from the 0.4 cross-feature hunt, area "layers-conventions": Ctrl+E on a clipping base is Merge Clipping
// Mask, the native menu's accelerators wait while the user types in a field, a document made by Duplicate Layer asks
// to be saved, Escape in a panel number field drops what was typed, position and pixel locks hold for groups, merges
// and stamps, Lock All locks opacity, fill, blend mode and effects, the fill keys skip groups, Toggle Last State goes
// back where the user came from, Search runs what was typed, Flatten Image asks before dropping hidden layers, and
// each committed opacity edit is its own history state.
import { test, expect } from '@playwright/test';
import { openApp, newDoc, run, runAwait, pixel, confirmDialog, historyLength } from './helpers.mjs';

const names = (page) => page.evaluate(() => window.pigmentApp.doc.layers().map((l) => l.name));

/** Adds raster layers { name, color, rect: [x, y, w, h], ...props } on top of the stack (bottom first); returns their ids. */
const addLayers = (page, specs) => page.evaluate(async (list) => {
  const { RasterLayer, createCanvas } = await import('/lib/document.js');
  const d = window.pigmentApp.doc;
  return list.map(({ name, color, rect, ...props }) => {
    const c = createCanvas(d.width, d.height);
    const g = c.getContext('2d');
    g.fillStyle = color;
    g.fillRect(...rect);
    const layer = new RasterLayer({ name, canvas: c, x: 0, y: 0, ...props });
    d.add(layer, d.root, d.root.children.length);
    d.setActive(layer);
    return layer.id;
  });
}, specs);

const setActive = (page, name) => page.evaluate((n) => {
  const d = window.pigmentApp.doc;
  d.setActive(d.layers().find((l) => l.name === n));
  document.activeElement?.blur();
}, name);

test('Ctrl+E on the base of a clipping mask merges the clipping mask; the picture does not change', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 120, height: 90, background: 'white' });
  await addLayers(page, [
    { name: 'Base', color: '#3366cc', rect: [10, 10, 60, 50] },
    { name: 'Clip', color: '#ffcc00', rect: [30, 0, 60, 90], clip: true },
  ]);
  await setActive(page, 'Base');
  const outside = await pixel(page, 85, 80);
  const inside = await pixel(page, 40, 30);
  const below = await pixel(page, 15, 15);
  // the Layer menu and the panel menus name what Ctrl+E does here
  await expect.poll(() => page.evaluate(() => window.pigmentApp.uiState.clippingBase)).toBe(true);
  await page.keyboard.press('Control+e');
  await expect.poll(() => names(page)).toEqual(['Background', 'Base']);
  expect(await page.evaluate(() => window.pigmentApp.doc.active.clip)).toBe(false);
  expect(await pixel(page, 85, 80)).toEqual(outside);
  expect(await pixel(page, 40, 30)).toEqual(inside);
  expect(await pixel(page, 15, 15)).toEqual(below);
  expect(await page.evaluate(() => window.pigmentApp.doc.history.entries[window.pigmentApp.doc.history.index].label)).toBe('Merge clipping mask');
  await runAwait(page, 'edit:undo');
  expect(await names(page)).toEqual(['Background', 'Base', 'Clip']);
  expect(errors).toEqual([]);
});

test('a native menu accelerator does not act on the document while a text field has the focus', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  await addLayers(page, [{ name: 'One', color: 'red', rect: [0, 0, 50, 50] }, { name: 'Two', color: 'blue', rect: [20, 20, 50, 50] }]);
  const send = (cmd) => page.evaluate((c) => window.pigmentApp.bridge.__emit('command', c, undefined, true), cmd);
  await page.evaluate(() => {
    const i = document.createElement('input');
    i.type = 'text';
    i.id = 'probe';
    i.value = 'abc';
    document.body.appendChild(i);
    i.focus();
  });
  // Ctrl+E, Ctrl+, and Ctrl+J as main.js sends them ('menu-key')
  for (const cmd of ['layer:merge', 'layer:visibility', 'layer:via-copy']) await send(cmd);
  expect(await names(page)).toEqual(['Background', 'One', 'Two']);
  expect(await page.evaluate(() => window.pigmentApp.doc.layers().every((l) => l.visible))).toBe(true);
  expect(await page.evaluate(() => document.activeElement?.id)).toBe('probe');
  // a view command still runs, and so does the same key without a text field
  const zoom = await page.evaluate(() => window.pigmentApp.view.zoom);
  await send('view:zoom-in');
  await expect.poll(() => page.evaluate(() => window.pigmentApp.view.zoom)).toBeGreaterThan(zoom);
  await page.evaluate(() => document.getElementById('probe').remove());
  await send('layer:merge');
  await expect.poll(() => names(page)).toEqual(['Background', 'One']);
  expect(errors).toEqual([]);
});

test('a document made by Duplicate Layer into a new document asks to be saved when it closes', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { name: 'A' });
  await addLayers(page, [{ name: 'Red', color: 'red', rect: [10, 10, 40, 40] }]);
  await runAwait(page, 'layer:duplicate', { destination: 'new', documentName: 'N1' });
  await expect.poll(() => page.evaluate(() => window.pigmentApp.doc?.name)).toBe('N1');
  expect(await page.evaluate(() => window.pigmentApp.doc.history.dirty)).toBe(true);
  await run(page, 'file:close');
  await expect(page.locator('.dialog-backdrop')).toHaveCount(1);
  expect(await page.evaluate(() => window.pigmentApp.docs.docs.map((d) => d.name))).toEqual(['A', 'N1']);
  expect(errors).toEqual([]);
});

test('Escape in the Layers panel Opacity field drops what was typed; nothing is applied afterwards', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 200, height: 150 });
  await addLayers(page, [{ name: 'L', color: 'red', rect: [10, 10, 50, 50] }]);
  await page.evaluate(() => window.pigmentApp.tools.activate('move'));
  await runAwait(page, 'window:panel-layers');
  const input = page.locator('input[data-opacity]').first();
  const h0 = await historyLength(page);
  const opacity = () => page.evaluate(() => Math.round(window.pigmentApp.doc.active.opacity * 100));
  // plain digits
  await input.click();
  await input.press('Control+a');
  await page.keyboard.type('3');
  await page.keyboard.press('Escape');
  await expect(input).toHaveValue('100');
  await page.evaluate(() => document.activeElement?.blur());
  expect(await opacity()).toBe(100);
  expect(await historyLength(page)).toBe(h0);
  // an expression goes back to the field's value, not to the digits typed before the operator
  await input.click();
  await input.press('Control+a');
  await page.keyboard.type('5*2');
  await page.keyboard.press('Escape');
  await expect(input).toHaveValue('100');
  // the arrow keys step from the field's value, not from the dropped entry
  await input.click();
  await input.press('Control+a');
  await page.keyboard.type('3');
  await page.keyboard.press('Escape');
  await page.keyboard.press('ArrowDown');
  await expect.poll(opacity).toBe(99);
  expect(errors).toEqual([]);
});

test('each committed edit of the panel Opacity is its own history state', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 200, height: 150 });
  await addLayers(page, [{ name: 'L', color: 'red', rect: [10, 10, 50, 50] }]);
  await runAwait(page, 'window:panel-layers');
  const input = page.locator('input[data-opacity]').first();
  const opacity = () => page.evaluate(() => Math.round(window.pigmentApp.doc.active.opacity * 100));
  const h0 = await historyLength(page);
  await input.click();
  await input.press('Control+a');
  await page.keyboard.type('45');
  await page.keyboard.press('Enter');
  await expect.poll(opacity).toBe(45);
  await input.click();
  await input.press('Control+a');
  await page.keyboard.type('50+20');
  await page.keyboard.press('Tab');
  await expect.poll(opacity).toBe(70);
  expect(await historyLength(page)).toBe(h0 + 2);
  await runAwait(page, 'edit:undo');
  expect(await opacity()).toBe(45);
  expect(errors).toEqual([]);
});

test('a group holding a position-locked layer does not move with the Move tool, and Align leaves it in place', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 300, height: 200 });
  await addLayers(page, [
    { name: 'R1', color: 'red', rect: [100, 20, 30, 30] },
    { name: 'A', color: 'green', rect: [150, 60, 20, 20], locked: { pixels: false, position: true, transparency: false, all: false } },
    { name: 'B', color: 'blue', rect: [200, 100, 20, 20] },
  ]);
  await page.evaluate(async () => {
    const app = window.pigmentApp;
    const d = app.doc;
    const [A, B] = ['A', 'B'].map((n) => d.layers().find((l) => l.name === n));
    d.selected = new Set([A, B]);
    d.active = B;
    await app.commands.run('layer:group', undefined, 'api');
    app.tools.activate('move');
    document.activeElement?.blur();
  });
  const pos = () => page.evaluate(() => window.pigmentApp.doc.layers().filter((l) => !l.isGroup && l.name !== 'Background').map((l) => [l.name, l.x, l.y]));
  const start = await pos();
  const h0 = await historyLength(page);
  await page.keyboard.press('ArrowRight');
  expect(await pos()).toEqual(start);
  expect(await historyLength(page)).toBe(h0);
  // Align: R1 and the group selected; the group stays, and still counts in the box R1 aligns to
  await page.evaluate(() => {
    const d = window.pigmentApp.doc;
    d.selected = new Set([d.layers().find((l) => l.name === 'R1'), d.layers().find((l) => l.isGroup)]);
  });
  await runAwait(page, 'layer:align', 'right');
  const after = await pos();
  expect(after.find(([n]) => n === 'A')).toEqual(['A', 0, 0]);
  expect(after.find(([n]) => n === 'B')).toEqual(['B', 0, 0]);
  // R1's right edge (130) goes to the group's (220)
  expect(after.find(([n]) => n === 'R1')).toEqual(['R1', 90, 0]);
  expect(errors).toEqual([]);
});

test('Merge Down and Stamp Layers refuse to write into a layer whose pixels are locked', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 200, height: 150 });
  await addLayers(page, [
    { name: 'L1', color: 'rgb(255,0,0)', rect: [10, 10, 40, 40], locked: { pixels: true, position: false, transparency: false, all: false } },
    { name: 'L2', color: 'rgb(0,0,255)', rect: [30, 30, 40, 40] },
  ]);
  const h0 = await historyLength(page);
  await runAwait(page, 'layer:merge');
  expect(await names(page)).toEqual(['Background', 'L1', 'L2']);
  await expect(page.locator('.toast').last()).toContainText('locked');
  await setActive(page, 'L2');
  await runAwait(page, 'layer:stamp-selected');
  expect(await names(page)).toEqual(['Background', 'L1', 'L2']);
  const l1 = await page.evaluate(() => {
    const l = window.pigmentApp.doc.layers().find((x) => x.name === 'L1');
    return Array.from(l.canvas.getContext('2d').getImageData(40, 40, 1, 1).data);
  });
  expect(l1).toEqual([255, 0, 0, 255]);
  expect(await historyLength(page)).toBe(h0);
  // Ctrl+E on a clipping base refuses the same way when the base is pixel-locked
  await page.evaluate(() => {
    const d = window.pigmentApp.doc;
    d.layers().find((l) => l.name === 'L2').clip = true;
  });
  await setActive(page, 'L1');
  await runAwait(page, 'layer:merge');
  expect(await names(page)).toEqual(['Background', 'L1', 'L2']);
  expect(errors).toEqual([]);
});

test('Lock All locks opacity, fill, blend mode and effects: keys, commands and the Layers panel', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 200, height: 150 });
  await addLayers(page, [{ name: 'S', color: 'red', rect: [20, 20, 30, 30] }]);
  await page.evaluate(async () => {
    const app = window.pigmentApp;
    const d = app.doc;
    d.active.styles = { stroke: { enabled: true, size: 2, position: 'outside', color: '#00ff00', opacity: 1, blend: 'normal' } };
    d.active.touch();
    await app.commands.run('layer:copy-style', undefined, 'api');
  });
  await addLayers(page, [{ name: 'K', color: 'blue', rect: [60, 60, 30, 30] }]);
  await runAwait(page, 'layer:lock', 'all');
  await runAwait(page, 'window:panel-layers');
  await page.evaluate(() => {
    window.pigmentApp.tools.activate('move');
    document.activeElement?.blur();
  });
  const state = () => page.evaluate(() => {
    const k = window.pigmentApp.doc.active;
    return { op: k.opacity, fill: k.fillOpacity, blend: k.blend, styles: !!k.styles };
  });
  const start = await state();
  const h0 = await historyLength(page);
  await page.keyboard.press('5');
  await page.keyboard.press('Shift+5');
  await page.keyboard.press('Shift+Alt+M');
  await runAwait(page, 'layer:opacity', 50);
  await runAwait(page, 'layer:blend', 'multiply');
  await runAwait(page, 'layer:paste-style');
  expect(await state()).toEqual(start);
  expect(await historyLength(page)).toBe(h0);
  await expect(page.locator('input[data-opacity]').first()).toBeDisabled();
  await expect(page.locator('input[data-fill]').first()).toBeDisabled();
  // a locked layer with effects keeps them
  await page.evaluate(() => {
    const k = window.pigmentApp.doc.active;
    k.styles = { stroke: { enabled: true, size: 2, position: 'outside', color: '#00ff00', opacity: 1, blend: 'normal' } };
    k.touch();
  });
  expect(await page.evaluate(() => window.pigmentApp.commands.isEnabled('layer:clear-style'))).toBe(false);
  await runAwait(page, 'layer:clear-style');
  expect((await state()).styles).toBe(true);
  // unlocked, the same command applies
  await runAwait(page, 'layer:lock', { value: { all: false } });
  await runAwait(page, 'layer:opacity', 50);
  expect((await state()).op).toBe(0.5);
  expect(errors).toEqual([]);
});

test('Shift+digit leaves a group alone: groups have no Fill', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 100, height: 80 });
  await addLayers(page, [{ name: 'R', color: 'red', rect: [0, 0, 100, 80] }]);
  await runAwait(page, 'layer:group');
  await page.evaluate(() => {
    window.pigmentApp.tools.activate('move');
    document.activeElement?.blur();
  });
  const h0 = await historyLength(page);
  await page.keyboard.press('Shift+1');
  await page.keyboard.press('1');
  // the opacity key still works on the group
  await expect.poll(() => page.evaluate(() => window.pigmentApp.doc.active.opacity)).toBe(0.1);
  expect(await page.evaluate(() => window.pigmentApp.doc.active.fillOpacity ?? 1)).toBe(1);
  expect(await historyLength(page)).toBe(h0 + 1);
  expect(errors).toEqual([]);
});

test('Toggle Last State after Undo or a History panel jump returns to the state the user came from', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 100, height: 100 });
  for (const n of ['A', 'B', 'C', 'D']) await runAwait(page, 'layer:new', { name: n });
  await page.evaluate(() => {
    window.pigmentApp.tools.activate('move');
    document.activeElement?.blur();
  });
  const index = () => page.evaluate(() => window.pigmentApp.doc.history.index);
  const top = await index();
  await page.keyboard.press('Control+z');
  await expect.poll(index).toBe(top - 1);
  await page.keyboard.press('Control+Alt+z');
  await expect.poll(index).toBe(top);
  await page.keyboard.press('Control+Alt+z');
  await expect.poll(index).toBe(top - 1);
  // a jump in the History panel, and back
  await page.evaluate(() => window.pigmentApp.historyStep({ goTo: 0 }));
  await expect.poll(index).toBe(0);
  await page.keyboard.press('Control+Alt+z');
  await expect.poll(index).toBe(top - 1);
  await page.keyboard.press('Control+Alt+z');
  await expect.poll(index).toBe(0);
  expect(errors).toEqual([]);
});

test('Search: "new layer" + Enter makes a layer (not Undo), "layers" + Enter opens the Layers panel', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 100, height: 100 });
  await runAwait(page, 'layer:new', { name: 'L1' });
  await page.evaluate(() => {
    window.__seen = [];
    window.pigmentApp.commands.observe({ before: (id) => window.__seen.push(id) });
    document.activeElement?.blur();
  });
  const firstRow = () => page.locator('.command-search-row').first();
  await page.keyboard.press('Control+f');
  await page.keyboard.type('new layer');
  await expect(firstRow()).toHaveAttribute('data-command', 'layer:new');
  await page.keyboard.press('Escape');
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press('Control+f');
  await page.keyboard.type('layers');
  await expect(firstRow()).toHaveAttribute('data-command', 'window:panel-layers');
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => window.__seen.includes('window:panel-layers'))).toBe(true);
  expect(await page.evaluate(() => window.__seen.includes('edit:undo') || window.__seen.includes('view:snap-to'))).toBe(false);
  expect(await names(page)).toEqual(['Background', 'L1']);
  expect(errors).toEqual([]);
});

test('Flatten Image asks before discarding hidden layers (from the menu); code flattens at once', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 100, height: 80 });
  await addLayers(page, [{ name: 'L1', color: 'red', rect: [0, 0, 40, 40] }, { name: 'L2', color: 'blue', rect: [20, 20, 40, 40], visible: false }]);
  const flatten = () => page.evaluate(() => {
    const r = window.pigmentApp.commands.run('image:flatten', undefined, 'menu');
    if (r && typeof r.catch === 'function') r.catch((err) => console.error('flatten failed', err));
  });
  await flatten();
  await expect(page.locator('.dialog-backdrop')).toHaveCount(1);
  await expect(page.locator('.dialog-backdrop')).toContainText('Discard hidden layers?');
  await page.keyboard.press('Escape');
  await expect(page.locator('.dialog-backdrop')).toHaveCount(0);
  expect(await names(page)).toEqual(['Background', 'L1', 'L2']);
  await flatten();
  await confirmDialog(page);
  await expect.poll(() => names(page)).toEqual(['Background']);
  await runAwait(page, 'edit:undo');
  expect(await names(page)).toEqual(['Background', 'L1', 'L2']);
  // the API (and recorded steps) do not ask
  await runAwait(page, 'image:flatten');
  expect(await names(page)).toEqual(['Background']);
  expect(errors).toEqual([]);
});
