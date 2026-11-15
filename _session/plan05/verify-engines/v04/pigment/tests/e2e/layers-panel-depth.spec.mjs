// layers-panel-depth (ARCHITECTURE.md "0.4 features", package 14): scrubby Opacity and Fill, lock buttons, the blend-mode
// menu with live preview and arrow keys, footer modifiers, drags (several rows, Alt copies, into groups, effect rows,
// the Background rules), the eye column, Alt-click to clip, nested groups, effect rows, the panel menu and Panel
// Options, Find Layers' new types, and isolation honoured by merged sampling and auto-select.
import { test, expect } from '@playwright/test';
import { openApp, newDoc, runAwait, pixel, historyLength } from './helpers.mjs';

/** A document with a white Background and painted layers { name, color, x, y, w, h, group } (bottom to top). */
async function build(page, layers = [], size = { width: 200, height: 120 }) {
  await newDoc(page, size);
  await page.evaluate(async (list) => {
    const app = window.pigmentApp;
    const { RasterLayer, GroupLayer, createCanvas } = await import('/lib/document.js');
    const d = app.doc;
    const groups = new Map();
    for (const s of list) {
      let l;
      if (s.isGroup) {
        l = new GroupLayer({ name: s.name });
        groups.set(s.name, l);
      } else {
        const c = createCanvas(d.width, d.height);
        const ctx = c.getContext('2d');
        ctx.fillStyle = s.color ?? '#ff0000';
        ctx.fillRect(s.x ?? 0, s.y ?? 0, s.w ?? 20, s.h ?? 20);
        l = new RasterLayer({ name: s.name, canvas: c, x: 0, y: 0 });
      }
      const parent = s.group ? groups.get(s.group) : d.root;
      d.add(l, parent, parent.children.length);
      d.setActive(l);
    }
    d.history.markSaved();
    app.panels.show('layers', { reveal: true });
  }, layers);
  await settle(page);
}

const settle = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
const layerOf = (page, name, key) => page.evaluate(([n, k]) => window.pigmentApp.doc.layers().find((l) => l.name === n)?.[k], [name, key]);
const tree = (page) => page.evaluate(() => {
  const walk = (g) => g.children.map((l) => (l.isGroup ? `${l.name}[${walk(l).join(',')}]` : l.name));
  return walk(window.pigmentApp.doc.root);
});
const select = (page, ...list) => page.evaluate(async (ns) => {
  const d = window.pigmentApp.doc;
  const ls = ns.map((n) => d.layers().find((l) => l.name === n));
  d.selected.clear();
  for (const l of ls) d.selected.add(l);
  d.active = ls[ls.length - 1];
  d.changed('active', { layer: d.active });
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
}, list);
const panel = (page) => page.locator('[data-panel="layers"]');
const row = (page, name) => panel(page).locator('.layer-list > .layer-row', { has: page.locator('.layer-name', { hasText: new RegExp(`^${name}$`) }) }).first();

/** Fires the panel's own drag events: from a row (or effect row) onto a row at fraction y of its height, or onto a footer button. */
async function dnd(page, from, to, { y = 0.5, alt = false } = {}) {
  return page.evaluate(({ from, to, y, alt }) => {
    const rows = [...document.querySelectorAll('[data-panel="layers"] .layer-list > li')];
    const find = (spec) => {
      if (spec.footer) return document.querySelector(`[data-panel="layers"] .panel-footer [data-cmd="${spec.footer}"]`);
      if (spec.effect) return rows.find((r) => r.classList.contains('layer-effect-row') && r.dataset.effect === spec.effect && r.querySelector('.layer-name') && window.pigmentApp.doc.find(r.dataset.id)?.name === spec.layer);
      if (spec.effects) return rows.find((r) => r.classList.contains('layer-effects-head') && window.pigmentApp.doc.find(r.dataset.id)?.name === spec.effects);
      return rows.find((r) => r.classList.contains('layer-row') && r.querySelector('.layer-name')?.textContent === spec);
    };
    const src = find(from), dst = find(to);
    if (!src || !dst) return { error: `missing ${!src ? JSON.stringify(from) : JSON.stringify(to)}` };
    src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() }));
    const r = dst.getBoundingClientRect();
    const at = { clientX: r.left + r.width / 2, clientY: r.top + r.height * y, altKey: alt };
    const over = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer(), ...at });
    dst.dispatchEvent(over);
    const cls = [...dst.classList].filter((k) => k.startsWith('drop-'));
    dst.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer(), ...at }));
    src.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() }));
    return { accepted: over.defaultPrevented, cls };
  }, { from, to, y, alt });
}

test('scrubby Opacity and Fill act on every selected layer in one history entry; typed values; the Background\'s are locked', async ({ page }) => {
  const errors = await openApp(page);
  await build(page, [{ name: 'A' }, { name: 'B' }, { name: 'C' }]);
  await select(page, 'A', 'B');
  const h0 = await historyLength(page);
  const label = panel(page).locator('.layers-percent .numeric-label', { hasText: 'Opacity' });
  const box = await label.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x - 30, box.y + box.height / 2, { steps: 10 });
  await page.mouse.up();
  const [a, b, c] = await Promise.all(['A', 'B', 'C'].map((n) => layerOf(page, n, 'opacity')));
  expect(a).toBeLessThan(1);
  expect(a).toBe(b);
  expect(c).toBe(1);
  expect(await historyLength(page)).toBe(h0 + 1);
  // a typed value applies on Enter, to both
  const input = panel(page).locator('input[data-opacity]');
  await input.fill('35');
  await input.press('Enter');
  await expect.poll(() => layerOf(page, 'A', 'opacity')).toBe(0.35);
  expect(await layerOf(page, 'B', 'opacity')).toBe(0.35);
  // Fill
  const fill = panel(page).locator('input[data-fill]');
  await fill.fill('20');
  await fill.press('Tab');
  await expect.poll(() => layerOf(page, 'B', 'fillOpacity')).toBe(0.2);
  expect(await layerOf(page, 'A', 'fillOpacity')).toBe(0.2);
  // the arrow keys step live (one merged entry)
  const before = await historyLength(page);
  await input.focus();
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await expect.poll(() => layerOf(page, 'A', 'opacity')).toBe(0.37);
  expect(await historyLength(page)).toBe(before + 1);
  // the Background's opacity, fill and blend mode are locked (L.13): their controls are disabled
  await select(page, 'Background');
  await expect(input).toBeDisabled();
  await expect(fill).toBeDisabled();
  await expect(panel(page).locator('.blend-mode-button')).toBeDisabled();
  expect(errors).toEqual([]);
});

test('lock buttons lock every selected layer; a mixed state is shown', async ({ page }) => {
  const errors = await openApp(page);
  await build(page, [{ name: 'A' }, { name: 'B' }]);
  await select(page, 'A', 'B');
  const h0 = await historyLength(page);
  await panel(page).locator('[data-lock="position"]').click();
  expect(await layerOf(page, 'A', 'locked')).toMatchObject({ position: true });
  expect(await layerOf(page, 'B', 'locked')).toMatchObject({ position: true });
  expect(await historyLength(page)).toBe(h0 + 1);
  await select(page, 'A');
  await panel(page).locator('[data-lock="pixels"]').click();
  await select(page, 'A', 'B');
  await expect(panel(page).locator('[data-lock="pixels"]')).toHaveClass(/mixed/);
  await expect(panel(page).locator('[data-lock="position"]')).not.toHaveClass(/mixed/);
  expect(errors).toEqual([]);
});

test('the blend-mode menu previews while hovering, commits on click, steps with the arrow keys and cancels with Escape', async ({ page }) => {
  const errors = await openApp(page);
  await build(page, [{ name: 'A', color: '#ff0000', w: 200, h: 120 }, { name: 'B', color: '#ff0000', x: 0, y: 0, w: 10, h: 10 }]);
  await select(page, 'A', 'B');
  const button = panel(page).locator('.blend-mode-button');
  await expect(button).toHaveText('Normal');
  const h0 = await historyLength(page);
  await button.click();
  const list = page.locator('.blend-mode-list');
  await expect(list).toBeVisible();
  // hover: Difference of red over white is cyan, on the canvas at once, without history
  await list.locator('[data-mode="difference"]').hover();
  await expect.poll(async () => (await pixel(page, 100, 60)).slice(0, 3)).toEqual([0, 255, 255]);
  expect(await layerOf(page, 'B', 'blend')).toBe('difference');
  expect(await historyLength(page)).toBe(h0);
  // off the list: the layers' own mode again
  await page.mouse.move(5, 5);
  await expect.poll(() => layerOf(page, 'A', 'blend')).toBe('normal');
  // a click commits for both selected layers, one entry
  await list.locator('[data-mode="screen"]').click();
  await expect(list).toHaveCount(0);
  expect(await layerOf(page, 'A', 'blend')).toBe('screen');
  expect(await layerOf(page, 'B', 'blend')).toBe('screen');
  expect(await historyLength(page)).toBe(h0 + 1);
  expect(await page.evaluate(() => window.pigmentApp.doc.history.dirty)).toBe(true);
  // closed and focused: ArrowDown commits the next mode
  await button.focus();
  await page.keyboard.press('ArrowDown');
  expect(await layerOf(page, 'A', 'blend')).toBe('color-dodge');
  expect(await historyLength(page)).toBe(h0 + 2);
  // open: the arrows preview, Escape puts the layers back (the pointer away from the list, which would preview too)
  await page.mouse.move(5, 5);
  await page.keyboard.press('Enter');
  await expect(list).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  expect(await layerOf(page, 'A', 'blend')).toBe('lighter-color');
  await page.keyboard.press('Escape');
  await expect(list).toHaveCount(0);
  expect(await layerOf(page, 'A', 'blend')).toBe('color-dodge');
  expect(await historyLength(page)).toBe(h0 + 2);
  // a preview never survives a command: it ends before the command runs
  await button.click();
  await list.locator('[data-mode="multiply"]').hover();
  expect(await layerOf(page, 'A', 'blend')).toBe('multiply');
  const seen = await page.evaluate(() => {
    const app = window.pigmentApp;
    let blendInside = null;
    const off = app.commands.observe({ after: () => (blendInside = app.doc.layers().find((l) => l.name === 'A').blend) });
    app.commands.run('view:zoom-in', undefined, 'api');
    off();
    return blendInside;
  });
  expect(seen).toBe('color-dodge');
  expect(errors).toEqual([]);
});

test('footer modifiers: Ctrl-click New Layer adds below, Alt-click asks; New Group Alt-click asks; the mask button adds a vector mask second', async ({ page }) => {
  const errors = await openApp(page);
  await build(page, [{ name: 'A' }, { name: 'B' }]);
  await select(page, 'B');
  const footer = panel(page).locator('.panel-footer');
  await footer.locator('[data-cmd="layer:new"]').click({ modifiers: ['Control'] });
  expect(await tree(page)).toEqual(['Background', 'A', 'Layer 1', 'B']);
  await footer.locator('[data-cmd="layer:new"]').click({ modifiers: ['Alt'] });
  await expect(page.locator('.new-layer-dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.new-layer-dialog')).toHaveCount(0);
  await footer.locator('[data-cmd="layer:new-group"]').click({ modifiers: ['Alt'] });
  await expect(page.locator('.new-group-dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await footer.locator('[data-cmd="layer:new"]').click();
  expect((await tree(page)).length).toBe(5);
  await expect(page.locator('.dialog-backdrop')).toHaveCount(0);
  // the mask button: a layer mask, then a vector mask; Alt hides all
  await select(page, 'B');
  await footer.locator('[data-cmd="layer:mask"]').click();
  expect(await page.evaluate(() => !!window.pigmentApp.doc.active.mask)).toBe(true);
  await footer.locator('[data-cmd="layer:mask"]').click();
  expect(await page.evaluate(() => !!window.pigmentApp.doc.active.vectorMask)).toBe(true);
  await select(page, 'A');
  await footer.locator('[data-cmd="layer:mask"]').click({ modifiers: ['Alt'] });
  const m = await page.evaluate(() => Array.from(window.pigmentApp.doc.active.mask.canvas.getContext('2d').getImageData(5, 5, 1, 1).data));
  expect(m[3] === 0 || m[0] === 0).toBe(true);
  expect(errors).toEqual([]);
});

test('drags: selected rows move together in one entry, Alt copies, into a group, onto New Layer and Delete; the Background rules refuse', async ({ page }) => {
  const errors = await openApp(page);
  await build(page, [{ name: 'G', isGroup: true }, { name: 'X', group: 'G' }, { name: 'A' }, { name: 'B' }, { name: 'C' }]);
  await select(page, 'A', 'C');
  const h0 = await historyLength(page);
  // A and C dropped into the group, keeping their order, one entry
  let r = await dnd(page, 'C', 'G', { y: 0.85 });
  expect(r).toEqual({ accepted: true, cls: ['drop-into'] });
  expect(await tree(page)).toEqual(['Background', 'G[X,A,C]', 'B']);
  expect(await historyLength(page)).toBe(h0 + 1);
  // a drop below the Background is refused: no indicator, nothing moves
  r = await dnd(page, 'B', 'Background', { y: 0.9 });
  expect(r).toEqual({ accepted: false, cls: [] });
  expect(await tree(page)).toEqual(['Background', 'G[X,A,C]', 'B']);
  // the Background itself cannot be dragged above another layer
  r = await dnd(page, 'Background', 'B', { y: 0.1 });
  expect(r.accepted).toBe(false);
  // a group cannot go into itself
  await select(page, 'G');
  r = await dnd(page, 'G', 'X', { y: 0.2 });
  expect(r.accepted).toBe(false);
  // Alt-drag copies
  await select(page, 'B');
  r = await dnd(page, 'B', 'G', { y: 0.1, alt: true });
  expect(r.accepted).toBe(true);
  expect(await tree(page)).toEqual(['Background', 'G[X,A,C]', 'B copy', 'B']);
  // onto New Layer: duplicates; onto Delete: deletes
  await select(page, 'B');
  r = await dnd(page, 'B', { footer: 'layer:new' });
  expect(r.accepted).toBe(true);
  expect(await tree(page)).toEqual(['Background', 'G[X,A,C]', 'B copy', 'B', 'B copy']);
  await select(page, 'B copy');
  r = await dnd(page, 'B copy', { footer: 'layer:delete' });
  expect(r.accepted).toBe(true);
  expect((await tree(page)).filter((n) => n === 'B copy').length).toBe(1);
  expect((await tree(page)).length).toBe(4);
  expect(errors).toEqual([]);
});

test('the eye column: a drag down the eyes hides each layer passed over in one entry; a click toggles; Alt-click solos', async ({ page }) => {
  const errors = await openApp(page);
  await build(page, [{ name: 'A' }, { name: 'B' }, { name: 'C' }]);
  const h0 = await historyLength(page);
  const eye = async (n) => {
    const b = await row(page, n).locator('.eye').boundingBox();
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  };
  const [c, b, a] = [await eye('C'), await eye('B'), await eye('A')];
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 4 });
  // the canvas shows it while dragging
  expect(await layerOf(page, 'B', 'visible')).toBe(false);
  expect(await historyLength(page)).toBe(h0);
  await page.mouse.move(a.x, a.y, { steps: 4 });
  await page.mouse.up();
  await expect.poll(() => Promise.all(['A', 'B', 'C', 'Background'].map((n) => layerOf(page, n, 'visible')))).toEqual([false, false, false, true]);
  expect(await historyLength(page)).toBe(h0 + 1);
  await runAwait(page, 'edit:undo');
  expect(await Promise.all(['A', 'B', 'C'].map((n) => layerOf(page, n, 'visible')))).toEqual([true, true, true]);
  await settle(page);
  // a click toggles one layer
  await row(page, 'B').locator('.eye').click();
  expect(await layerOf(page, 'B', 'visible')).toBe(false);
  await row(page, 'B').locator('.eye').click();
  expect(await layerOf(page, 'B', 'visible')).toBe(true);
  // a command arriving during a sweep ends it without a change
  await settle(page);
  const h1 = await historyLength(page);
  const [c2, b2] = [await eye('C'), await eye('B')];
  await page.mouse.move(c2.x, c2.y);
  await page.mouse.down();
  await page.mouse.move(b2.x, b2.y, { steps: 4 });
  expect(await layerOf(page, 'C', 'visible')).toBe(false);
  await runAwait(page, 'view:zoom-in');
  expect(await layerOf(page, 'C', 'visible')).toBe(true);
  await page.mouse.up();
  expect(await Promise.all(['A', 'B', 'C'].map((n) => layerOf(page, n, 'visible')))).toEqual([true, true, true]);
  expect(await historyLength(page)).toBe(h1);
  await settle(page);
  // Alt-click: only this one
  await row(page, 'A').locator('.eye').click({ modifiers: ['Alt'] });
  expect(await Promise.all(['A', 'B', 'C', 'Background'].map((n) => layerOf(page, n, 'visible')))).toEqual([true, false, false, false]);
  expect(errors).toEqual([]);
});

test('Alt-click on the line between two layers clips the upper one and releases it again', async ({ page }) => {
  const errors = await openApp(page);
  await build(page, [{ name: 'A' }, { name: 'B' }]);
  const altClick = async (x, y) => {
    await page.keyboard.down('Alt');
    await page.mouse.click(x, y);
    await page.keyboard.up('Alt');
  };
  const box = await row(page, 'B').boundingBox();
  // Alt over the line shows the clipping cursor
  await page.mouse.move(box.x + box.width / 2, box.y + box.height - 2);
  await page.keyboard.down('Alt');
  await page.mouse.move(box.x + box.width / 2 + 1, box.y + box.height - 2);
  await expect(panel(page).locator('.layer-list')).toHaveClass(/clip-cursor/);
  await page.keyboard.up('Alt');
  await altClick(box.x + box.width / 2, box.y + box.height - 2);
  expect(await layerOf(page, 'B', 'clip')).toBe(true);
  await settle(page);
  const boxA = await row(page, 'A').boundingBox();
  await altClick(boxA.x + boxA.width / 2, boxA.y + 2);
  expect(await layerOf(page, 'B', 'clip')).toBe(false);
  // Alt in the middle of a row is an ordinary click
  await altClick(boxA.x + boxA.width / 2, boxA.y + boxA.height / 2);
  expect(await layerOf(page, 'B', 'clip')).toBe(false);
  expect(await page.evaluate(() => window.pigmentApp.doc.active.name)).toBe('A');
  expect(errors).toEqual([]);
});

test('nested groups: Alt-click a triangle for the groups inside, Ctrl-click for all; Collapse All Groups; group masks and Pass Through', async ({ page }) => {
  const errors = await openApp(page);
  await build(page, [{ name: 'G1', isGroup: true }, { name: 'G2', isGroup: true, group: 'G1' }, { name: 'X', group: 'G2' }, { name: 'G3', isGroup: true }, { name: 'Y', group: 'G3' }]);
  const expanded = () => page.evaluate(() => Object.fromEntries(window.pigmentApp.doc.layers().filter((l) => l.isGroup).map((l) => [l.name, l.expanded])));
  await row(page, 'G1').locator('.layer-twisty').click({ modifiers: ['Alt'] });
  expect(await expanded()).toEqual({ G1: false, G2: false, G3: true });
  await row(page, 'G1').locator('.layer-twisty').click({ modifiers: ['Alt'] });
  expect(await expanded()).toEqual({ G1: true, G2: true, G3: true });
  await expect(row(page, 'X')).toBeVisible();
  await row(page, 'G3').locator('.layer-twisty').click({ modifiers: ['Control'] });
  expect(await expanded()).toEqual({ G1: false, G2: false, G3: false });
  await row(page, 'G3').locator('.layer-twisty').click();
  const h0 = await historyLength(page);
  await runAwait(page, 'layer:collapse-all-groups');
  expect(await expanded()).toEqual({ G1: false, G2: false, G3: false });
  expect(await historyLength(page)).toBe(h0);
  await settle(page);
  await expect(row(page, 'Y')).toHaveCount(0);
  const flags = await page.evaluate(() => ['layer:collapse-all-groups', 'layer:panel-options'].map((id) => [window.pigmentApp.stubbed.includes(id), window.pigmentApp.commands.commands.get(id).record]));
  expect(flags).toEqual([[false, false], [false, false]]);
  // a group with a mask shows the mask thumbnail; Pass Through is listed for a group
  await select(page, 'G1');
  await runAwait(page, 'layer:mask', 'reveal-all');
  await settle(page);
  await expect(row(page, 'G1').locator('.mask-thumb')).toHaveCount(1);
  await expect(panel(page).locator('.blend-mode-button')).toHaveText('Pass Through');
  await panel(page).locator('.blend-mode-button').click();
  await expect(page.locator('.blend-mode-list [data-mode="pass-through"]')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await select(page, 'G3');
  await runAwait(page, 'layer:group'); // G3 inside a new group: nesting three levels shows the rows indented
  await settle(page);
  expect(errors).toEqual([]);
});

test('effect rows: listed under the layer, per-effect eyes, Hide All, moved and copied between layers, deleted, edited', async ({ page }) => {
  const errors = await openApp(page);
  await build(page, [{ name: 'A', w: 60, h: 60, x: 20, y: 20 }, { name: 'B', w: 40, h: 40, x: 120, y: 40 }]);
  await select(page, 'A');
  await runAwait(page, 'layer:style', { styles: { dropShadow: { enabled: true }, stroke: { enabled: true, size: 4 } } });
  await settle(page);
  const effectRows = () => panel(page).locator('.layer-effect-row').evaluateAll((els) => els.map((e) => `${window.pigmentApp.doc.find(e.dataset.id).name}:${e.dataset.effect ?? 'head'}${e.classList.contains('off') ? ':off' : ''}`));
  expect(await effectRows()).toEqual(['A:all', 'A:dropShadow', 'A:stroke'].map((s) => s.replace(':all', ':head')));
  // the stroke's eye: switched off, still listed, one entry
  const h0 = await historyLength(page);
  await panel(page).locator('.layer-effect-row[data-effect="stroke"] .eye').click();
  expect(await page.evaluate(() => { const s = window.pigmentApp.doc.layers().find((l) => l.name === 'A').styles.stroke; return [s.enabled, s.present]; })).toEqual([false, true]);
  expect(await historyLength(page)).toBe(h0 + 1);
  await settle(page);
  expect(await effectRows()).toEqual(['A:head', 'A:dropShadow', 'A:stroke:off']);
  // the header's eye: Hide All Effects
  await panel(page).locator('.layer-effects-head .eye').click();
  expect(await page.evaluate(() => window.pigmentApp.doc.layers().find((l) => l.name === 'A').styles.hidden)).toBe(true);
  await panel(page).locator('.layer-effects-head .eye').click();
  expect(await page.evaluate(() => window.pigmentApp.doc.layers().find((l) => l.name === 'A').styles.hidden)).toBeUndefined();
  await settle(page);
  // the drop shadow dragged onto B: moved, one entry for both layers
  const h1 = await historyLength(page);
  let r = await dnd(page, { effect: 'dropShadow', layer: 'A' }, 'B');
  expect(r.accepted).toBe(true);
  expect(await historyLength(page)).toBe(h1 + 1);
  const shadowOn = (n) => page.evaluate((name) => { const s = window.pigmentApp.doc.layers().find((l) => l.name === name).styles; const v = s?.dropShadow; return !!(Array.isArray(v) ? v.some((x) => x.enabled) : v?.enabled); }, n);
  expect([await shadowOn('A'), await shadowOn('B')]).toEqual([false, true]);
  await settle(page);
  // Alt copies it back
  r = await dnd(page, { effect: 'dropShadow', layer: 'B' }, 'A', { alt: true });
  expect([await shadowOn('A'), await shadowOn('B')]).toEqual([true, true]);
  await settle(page);
  // an effect onto Delete
  r = await dnd(page, { effect: 'stroke', layer: 'A' }, { footer: 'layer:delete' });
  expect(r.accepted).toBe(true);
  expect(await page.evaluate(() => !!window.pigmentApp.doc.layers().find((l) => l.name === 'A').styles?.stroke?.present)).toBe(false);
  expect(await tree(page)).toEqual(['Background', 'A', 'B']);
  await settle(page);
  // the Effects row onto another layer moves every effect
  r = await dnd(page, { effects: 'B' }, 'A');
  expect(r.accepted).toBe(true);
  expect(await page.evaluate(() => window.pigmentApp.doc.layers().find((l) => l.name === 'B').styles)).toBeNull();
  // effects never go onto the Background (its styles are locked)
  await settle(page);
  r = await dnd(page, { effects: 'A' }, 'Background');
  expect(r.accepted).toBe(false);
  // the fx triangle closes the list
  await row(page, 'A').locator('.layer-fx-twisty').click();
  await settle(page);
  await expect(panel(page).locator('.layer-effect-row')).toHaveCount(0);
  await row(page, 'A').locator('.layer-fx-twisty').click();
  await settle(page);
  // a double-click opens the Layer Style dialog on that effect
  await panel(page).locator('.layer-effect-row[data-effect="dropShadow"] .layer-name').dblclick();
  await expect(page.locator('.dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.dialog-backdrop')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('effect rows of a group (layer-style-blending: styles on groups)', async ({ page }) => {
  const errors = await openApp(page);
  await build(page, [{ name: 'G', isGroup: true }, { name: 'X', group: 'G' }]);
  const styleable = await page.evaluate(async () => {
    const { isStyleable } = await import('/lib/blending-options.js');
    const d = window.pigmentApp.doc;
    return isStyleable(d.layers().find((l) => l.name === 'G'), window.pigmentApp);
  });
  expect(styleable).toBe(true); // layer-style-blending: groups take styles
  await select(page, 'G');
  await runAwait(page, 'layer:style', { styles: { outerGlow: { enabled: true }, colorOverlay: { enabled: true, color: '#00ff00' } } });
  await settle(page);
  const order = await panel(page).locator('.layer-list > li').evaluateAll((els) => els.map((e) => (e.classList.contains('layer-effect-row') ? `fx:${e.dataset.effect ?? 'head'}` : e.querySelector('.layer-name')?.textContent)));
  expect(order).toEqual(['G', 'fx:head', 'fx:outerGlow', 'fx:colorOverlay', 'X', 'Background']);
  await panel(page).locator('.layer-effect-row[data-effect="colorOverlay"] .eye').click();
  expect(await page.evaluate(() => window.pigmentApp.doc.layers().find((l) => l.name === 'G').styles.colorOverlay.enabled)).toBe(false);
  expect(errors).toEqual([]);
});

test('the panel menu lists Photoshop\'s commands (stubs disabled); Panel Options change the thumbnails and the effect rows', async ({ page }) => {
  const errors = await openApp(page);
  await build(page, [{ name: 'A', x: 150, y: 80, w: 20, h: 20 }]);
  await runAwait(page, 'layer:style', { styles: { stroke: { enabled: true } } });
  await settle(page);
  await panel(page).locator('[data-panel-menu]').click();
  const items = page.locator('.popover .popover-item');
  const labels = await items.allTextContents();
  for (const l of ['New Layer…', 'Duplicate Layer…', 'Delete Layer', 'Delete Hidden Layers', 'New Group…', 'New Group from Layers…', 'Collapse All Groups', 'Lock Layers…', 'Convert to Smart Object', 'Blending Options…', 'Create Clipping Mask', 'Link Layers', 'Merge Down', 'Merge Visible', 'Flatten Image', 'Panel Options…']) {
    expect(labels.some((t) => t.includes(l)), l).toBe(true);
  }
  // an entry whose command is still a stub is present and disabled
  const stubbed = await page.evaluate(() => window.pigmentApp.stubbed);
  for (const [label, id] of [['Lock Layers…', 'layer:lock-dialog'], ['Merge Down', 'layer:merge'], ['Collapse All Groups', 'layer:collapse-all-groups']]) {
    if (stubbed.includes(id)) await expect(items.filter({ hasText: label }).first()).toBeDisabled();
  }
  await items.filter({ hasText: 'Panel Options…' }).click();
  const dlg = page.locator('.dialog.layers-panel-options, .layers-panel-options .dialog, .dialog:has([data-key="thumbSize"])').first();
  await expect(dlg).toBeVisible();
  await dlg.locator('.seg-button[data-value="large"]').click();
  await dlg.locator('select[data-key="thumbBounds"]').selectOption('document');
  await dlg.locator('input[data-key="showEffects"]').uncheck();
  await page.locator('.dialog-backdrop .dialog-buttons .btn.primary').last().click();
  await expect.poll(() => page.evaluate(() => window.pigmentApp.settings.layersPanel)).toMatchObject({ thumbSize: 'large', thumbBounds: 'document', showEffects: false, expandEffects: true, addCopy: true });
  await settle(page);
  expect(Math.round((await row(page, 'A').boundingBox()).height)).toBe(62);
  await expect(panel(page).locator('.layer-effect-row')).toHaveCount(0);
  // Entire Document: the thumbnail has the canvas' aspect (200 x 120 in 64 x 52 gives 64 x 38)
  const size = await row(page, 'A').locator('.layer-thumb canvas').evaluate((c) => [c.width, c.height]);
  expect(size).toEqual([64, 38]);
  // the API sets them without the dialog: Layer Bounds crops to the layer's pixels (a 20 x 20 square)
  await runAwait(page, 'layer:panel-options', { thumbSize: 'medium', thumbBounds: 'layer', showEffects: true });
  await settle(page);
  expect(Math.round((await row(page, 'A').boundingBox()).height)).toBe(40);
  const sq = await row(page, 'A').locator('.layer-thumb canvas').evaluate((c) => [c.width, c.height]);
  expect(sq[0]).toBe(sq[1]);
  await expect(panel(page).locator('.layer-effect-row')).toHaveCount(2);
  await runAwait(page, 'layer:panel-options', { thumbSize: 'none' });
  await settle(page);
  await expect(row(page, 'A').locator('.layer-thumb canvas')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('Find Layers: the Selected type and the vector mask and advanced blending attributes', async ({ page }) => {
  const errors = await openApp(page);
  await build(page, [{ name: 'A' }, { name: 'B' }, { name: 'C' }]);
  const shown = async () => {
    await settle(page);
    return panel(page).locator('.layer-list > .layer-row .layer-name').allTextContents();
  };
  await select(page, 'A', 'C');
  await page.evaluate(() => window.pigmentApp.setLayerFilter({ type: 'selected', on: true }));
  expect(await shown()).toEqual(['C', 'A']);
  await select(page, 'B');
  await runAwait(page, 'layer:vector-mask', 'reveal-all');
  await page.evaluate(() => window.pigmentApp.setLayerFilter({ type: 'attribute', attribute: 'vectorMask', on: true }));
  expect(await shown()).toEqual(['B']);
  await select(page, 'C');
  await page.evaluate(async () => {
    const { DEFAULT_BLENDING } = await import('/lib/document.js');
    window.pigmentApp.commands.run('layer:style', { blending: { ...JSON.parse(JSON.stringify(DEFAULT_BLENDING)), knockout: 'deep' } }, 'api');
  });
  await page.evaluate(() => window.pigmentApp.setLayerFilter({ type: 'attribute', attribute: 'advancedBlending', on: true }));
  expect(await shown()).toEqual(['C']);
  await page.evaluate(() => window.pigmentApp.setLayerFilter({ type: 'attribute', attribute: 'unlocked', on: true }));
  expect(await shown()).toEqual(['C', 'B', 'A', 'Background']);
  await select(page, 'A');
  await runAwait(page, 'layer:lock', 'position');
  expect(await shown()).toEqual(['C', 'B', 'Background']);
  await page.evaluate(() => window.pigmentApp.setLayerFilter({ on: false }));
  expect((await shown()).length).toBe(4);
  expect(errors).toEqual([]);
});

test('Isolate Layers: merged sampling and auto-select see only the isolated layers', async ({ page }) => {
  const errors = await openApp(page);
  await build(page, [{ name: 'Red', color: '#ff0000', w: 50, h: 50 }, { name: 'Blue', color: '#0000ff', w: 50, h: 50 }]);
  const sample = () => page.evaluate(() => Array.from(window.pigmentApp.sampleMerged(window.pigmentApp.doc).getContext('2d').getImageData(10, 10, 1, 1).data));
  expect(await sample()).toEqual([0, 0, 255, 255]);
  await select(page, 'Red');
  await runAwait(page, 'select:isolate-layers', true);
  expect(await sample()).toEqual([255, 0, 0, 255]);
  // outside the red square: nothing (the Background is not isolated)
  expect(await page.evaluate(() => window.pigmentApp.sampleMerged(window.pigmentApp.doc).getContext('2d').getImageData(100, 100, 1, 1).data[3])).toBe(0);
  // the Eyedropper reads the same merged image
  const hit = await page.evaluate(() => window.pigmentApp.tools.get('move').hitTest({ x: 10, y: 10 })?.name ?? null);
  expect(hit).toBe('Red');
  await runAwait(page, 'select:isolate-layers', false);
  expect(await sample()).toEqual([0, 0, 255, 255]);
  expect(await page.evaluate(() => window.pigmentApp.tools.get('move').hitTest({ x: 10, y: 10 })?.name ?? null)).toBe('Blue');
  expect(errors).toEqual([]);
});
