// Regressions from the review of the 0.4 hunt fixes: the Layers panel's layer-style items follow the commands, a
// clipped layer's base is made opaque once per base version (not on every composite), Merge Clipping Mask refuses an
// adjustment-layer base and keeps the base's Blend If live, a Type session's own formatting is part of its Make Text
// Layer step, Escape in a field that applies as you type takes the typed value back, and Align moves a shape with an
// odd centred stroke so that it stays inside the reference box.
import { test, expect } from '@playwright/test';
import { openApp, newDoc, runAwait, pixel, screenPoint } from './helpers.mjs';

/** The flattened document as an array of bytes. */
const composite = (page) => page.evaluate(() => {
  const d = window.pigmentApp.doc;
  return Array.from(d.view.compositor.composite(d).getContext('2d').getImageData(0, 0, d.width, d.height).data);
});
const countDiff = (a, b) => {
  let n = 0;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 3) n++;
  return n;
};
const names = (page) => page.evaluate(() => window.pigmentApp.doc.layers().map((l) => `${l.name}:${l.type}`));
const labels = (page) => page.evaluate(() => {
  const h = window.pigmentApp.doc.history;
  return h.entries.slice(0, h.index + 1).map((e) => e.label);
});

/** Adds raster layers { name, color, rect: [x, y, w, h], ...props } on top of the stack (bottom first). */
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
const collectToasts = (page) => page.evaluate(() => {
  const app = window.pigmentApp;
  window.__toasts = [];
  const t = app.dialogs.toast.bind(app.dialogs);
  app.dialogs.toast = (m, o) => (window.__toasts.push(m), t(m, o));
});

test.beforeEach(async ({ page }) => {
  page.errors = await openApp(page);
});
test.afterEach(async ({ page }) => {
  expect(page.errors).toEqual([]);
});

test('the Layers panel menus offer Copy, Paste and Clear Layer Style exactly when the commands are enabled', async ({ page }) => {
  await newDoc(page, { width: 120, height: 90, background: 'white' });
  await addLayers(page, [{ name: 'Multiplied', color: '#3366cc', rect: [10, 10, 60, 50], blend: 'multiply', fillOpacity: 0.5 }]);
  await page.evaluate(() => window.pigmentApp.panels.show('layers', { reveal: true }));
  /** The layer-style items of the context menu of `selector` in the Layers panel, with (disabled) marks. */
  const menuOf = async (selector) => {
    const row = page.locator(selector).first();
    await expect(row).toBeVisible();
    await row.click({ button: 'right' });
    const items = page.locator('.popover [role="menuitem"]');
    await expect(items.first()).toBeVisible();
    const out = await items.evaluateAll((list) => list.filter((b) => /Layer Style$/.test(b.textContent.trim())).map((b) => `${b.textContent.trim()}${b.disabled ? ' (disabled)' : ''}`));
    await page.keyboard.press('Escape');
    await expect(page.locator('.popover')).toHaveCount(0);
    return out;
  };
  const rowOf = (name) => page.evaluate((n) => `[data-panel="layers"] .layer-row[data-id="${window.pigmentApp.doc.layers().find((l) => l.name === n).id}"]`, name);
  // a layer with only a blend mode and a fill has a layer style to copy and to clear; nothing is copied yet
  expect(await menuOf(await rowOf('Multiplied'))).toEqual(['Copy Layer Style', 'Paste Layer Style (disabled)', 'Clear Layer Style']);
  await runAwait(page, 'layer:copy-style');
  // the Background takes no style: nothing to copy, clear or paste there
  expect(await menuOf(await rowOf('Background'))).toEqual(['Copy Layer Style (disabled)', 'Paste Layer Style (disabled)', 'Clear Layer Style (disabled)']);
  // an effect row's menu follows the same commands: Lock All keeps the effects, so Clear and Paste are off there
  await page.evaluate(() => {
    const d = window.pigmentApp.doc;
    const l = d.layers().find((x) => x.name === 'Multiplied');
    l.styles = { dropShadow: { enabled: true } };
    l.locked = { ...l.locked, all: true };
    l.touch();
    d.setActive(l);
    d.changed('tree');
  });
  expect(await menuOf('[data-panel="layers"] .layer-effect-row[data-effect="dropShadow"]')).toEqual(['Copy Layer Style', 'Paste Layer Style (disabled)', 'Clear Layer Style (disabled)']);
});

test('a clipped layer reuses the opaque copy of its base until the base itself changes', async ({ page }) => {
  await newDoc(page, { width: 100, height: 60, background: 'white' });
  await addLayers(page, [
    { name: 'Base', color: 'rgba(0, 0, 0, 0.5)', rect: [0, 0, 100, 60] },
    { name: 'Red', color: '#ff0000', rect: [50, 0, 50, 60], clip: true },
  ]);
  const r = await page.evaluate(() => {
    const d = window.pigmentApp.doc;
    const comp = d.view.compositor;
    let made = 0;
    const own = comp.opaqueBase;
    const seen = new Set();
    comp.opaqueBase = function (work, base) {
      const out = own.call(this, work, base);
      if (!seen.has(out)) made++;
      seen.add(out);
      return out;
    };
    const [base, red] = d.layers().filter((l) => l.name === 'Base' || l.name === 'Red');
    comp.composite(d);
    // edits of the clipped layer (a stroke touches it on every dab) leave the base's opaque copy alone
    for (let i = 0; i < 3; i++) {
      red.touch();
      comp.composite(d);
    }
    const afterClipped = made;
    // an edit of the base makes it again: a pixel the base gains shows at once
    const g = base.canvas.getContext('2d');
    g.clearRect(0, 0, 25, 60);
    base.touch();
    const px = Array.from(comp.composite(d).getContext('2d').getImageData(10, 30, 1, 1).data);
    comp.opaqueBase = own;
    return { afterClipped, afterBase: made, px };
  });
  expect(r.afterClipped).toBe(1);
  expect(r.afterBase).toBe(2);
  expect(r.px).toEqual([255, 255, 255, 255]); // the base was cleared there: the white Background shows
  // the picture is still the single-alpha clipping of the hunt fix
  const right = await pixel(page, 70, 30);
  expect(Math.max(...right.map((v, i) => Math.abs(v - [255, 127, 127, 255][i])))).toBeLessThanOrEqual(2);
});

test('Ctrl+E on an adjustment layer that is a clipping base refuses and leaves the picture alone', async ({ page }) => {
  await newDoc(page, { width: 120, height: 90, background: 'white' });
  await addLayers(page, [{ name: 'Under', color: '#3366cc', rect: [0, 0, 120, 90] }]);
  await runAwait(page, 'layer:new-adjustment', { kind: 'invert' });
  await page.evaluate(() => (window.pigmentApp.doc.active.name = 'Adj'));
  await addLayers(page, [{ name: 'Clip', color: '#ffcc00', rect: [30, 0, 30, 90], clip: true }]);
  await setActive(page, 'Adj');
  await collectToasts(page);
  const before = await composite(page);
  const steps = await labels(page);
  await page.keyboard.press('Control+e');
  await expect.poll(() => page.evaluate(() => window.__toasts.some((m) => /adjustment layer/.test(m)))).toBe(true);
  expect(await names(page)).toEqual(['Background:raster', 'Under:raster', 'Adj:adjustment', 'Clip:raster']);
  expect(countDiff(before, await composite(page))).toBe(0);
  expect(await labels(page)).toEqual(steps);
});

test('Merge Clipping Mask keeps the base Blend If live, so the picture does not change; it warns where it will', async ({ page }) => {
  const merge = async (blending, { shadow = false } = {}) => {
    await newDoc(page, { width: 120, height: 90, background: 'white' });
    await addLayers(page, [
      { name: 'Under', color: '#88aa33', rect: [0, 40, 120, 50] },
      { name: 'Base', color: '#3366cc', rect: [10, 10, 60, 50] },
      { name: 'Clip', color: '#ffcc00', rect: [30, 0, 60, 90], clip: true, opacity: 0.7 },
    ]);
    await setActive(page, 'Base');
    await page.evaluate(async ([b, s]) => {
      const app = window.pigmentApp;
      const l = app.doc.active;
      if (s) await app.commands.run('layer:style', { styles: { dropShadow: [{ enabled: true, size: 4, distance: 6, angle: 120, opacity: 0.8, color: '#000000' }] } }, 'api');
      l.blending = b;
      l.touch();
      app.doc.changed('props', { layer: l });
    }, [blending, shadow]);
    await collectToasts(page);
    const a = await composite(page);
    await page.keyboard.press('Control+e');
    await expect.poll(() => names(page)).toEqual(['Background:raster', 'Under:raster', 'Base:raster']);
    return {
      diff: countDiff(a, await composite(page)),
      blendIf: await page.evaluate(() => window.pigmentApp.doc.active.blending?.blendIf?.gray ?? null),
      green: await page.evaluate(() => window.pigmentApp.doc.active.blending?.channels?.g ?? true),
      warned: await page.evaluate(() => window.__toasts.some((m) => /can change/.test(m))),
    };
  };
  const under = { blendIf: { gray: { this: [0, 0, 255, 255], under: [0, 0, 100, 160] } } };
  expect(await merge(under)).toEqual({ diff: 0, blendIf: under.blendIf.gray, green: true, warned: false });
  const own = { blendIf: { gray: { this: [0, 0, 120, 200], under: [0, 0, 255, 255] } } };
  expect(await merge(own)).toEqual({ diff: 0, blendIf: own.blendIf.gray, green: true, warned: false });
  // a channel restriction stays live as well
  expect(await merge({ channels: { r: true, g: false, b: true } })).toEqual({ diff: 0, blendIf: null, green: false, warned: false });
  // exterior effects are left alone by a live Blend If, not once they are merged in: the user is told
  expect((await merge(under, { shadow: true })).warned).toBe(true);
  // undo gives the clipping mask back
  await runAwait(page, 'edit:undo');
  expect(await names(page)).toEqual(['Background:raster', 'Under:raster', 'Base:raster', 'Clip:raster']);
});

test('formatting typed inside a new Type session is part of its Make Text Layer step, which plays back', async ({ page }) => {
  await newDoc(page, { width: 300, height: 200, background: 'white' });
  await page.evaluate(() => {
    const app = window.pigmentApp;
    const e = app.actions;
    e.record(e.newAction({ name: 'Bold type' }));
    app.tools.activate('type-horizontal');
  });
  const p = await screenPoint(page, 30, 60);
  await page.mouse.click(p.x, p.y);
  await expect.poll(() => page.evaluate(() => window.pigmentApp.doc.active?.type)).toBe('text');
  await page.keyboard.type('Hello');
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Control+Shift+B'); // Faux Bold
  await page.keyboard.press('Control+Shift+U'); // Underline
  await page.keyboard.press('Control+Enter');
  await expect.poll(() => page.evaluate(() => window.pigmentApp.tools.active?.session ?? null)).toBe(null);
  // after the session, Faux Bold on the layer is a step of its own
  await runAwait(page, 'type:toggle-faux-bold');
  const steps = await page.evaluate(() => {
    const e = window.pigmentApp.actions;
    e.stop();
    for (const s of e.sets) for (const a of s.actions) if (a.name === 'Bold type') return a.steps.map((x) => x.command);
    return null;
  });
  expect(steps).toEqual(['actions:make-layer', 'type:toggle-faux-bold']);
  const recorded = await page.evaluate(() => JSON.stringify(window.pigmentApp.doc.active.content));
  await newDoc(page, { width: 300, height: 200, background: 'white' });
  const played = await page.evaluate(() => window.pigmentApp.commands.run('actions:play', { action: 'Bold type' }, 'api'));
  expect(played?.ok).toBe(true);
  expect(await names(page)).toEqual(['Background:raster', 'Hello:text']);
  expect(await page.evaluate(() => JSON.stringify(window.pigmentApp.doc.active.content))).toBe(recorded);
  expect(JSON.parse(recorded).runs[0].style).toEqual({ underline: true }); // bold on in the session, off again after
  // a new text cancelled with Escape takes its formatting steps with it
  await page.evaluate(() => {
    const app = window.pigmentApp;
    const e = app.actions;
    e.record(e.newAction({ name: 'Cancelled type' }));
    app.tools.activate('type-horizontal');
  });
  const q = await screenPoint(page, 30, 150);
  await page.mouse.click(q.x, q.y);
  await expect.poll(() => page.evaluate(() => !!window.pigmentApp.tools.active?.session)).toBe(true);
  await page.keyboard.type('Gone');
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Control+Shift+B');
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => window.pigmentApp.tools.active?.session ?? null)).toBe(null);
  const left = await page.evaluate(async () => {
    await Promise.resolve();
    const e = window.pigmentApp.actions;
    e.stop();
    for (const s of e.sets) for (const a of s.actions) if (a.name === 'Cancelled type') return a.steps.map((x) => x.command);
    return null;
  });
  expect(left).toEqual([]);
  expect(await names(page)).toEqual(['Background:raster', 'Hello:text']);
});

test('Escape in a Properties adjustment field takes back the value it applied while typing', async ({ page }) => {
  await newDoc(page, { width: 120, height: 90, background: 'white' });
  await runAwait(page, 'layer:new-adjustment', { kind: 'brightness-contrast' });
  await page.evaluate(() => window.pigmentApp.panels.show('properties', { reveal: true }));
  const input = page.locator('[data-panel=properties] input[data-key=brightness]').first();
  await expect(input).toBeVisible();
  const steps = await labels(page);
  const brightness = () => page.evaluate(() => window.pigmentApp.doc.active.params.brightness);
  await input.click();
  await page.keyboard.press('Control+a');
  await page.keyboard.type('60');
  await expect.poll(brightness).toBe(60); // the editor applies as you type
  await page.keyboard.press('Escape');
  await expect(input).toHaveValue('0');
  await page.evaluate(() => document.activeElement?.blur());
  expect(await brightness()).toBe(0);
  expect(await labels(page)).toEqual(steps); // and its step is gone
  // a value committed with Enter stays, and Escape afterwards has nothing to take back
  await input.click();
  await page.keyboard.press('Control+a');
  await page.keyboard.type('25');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  await page.evaluate(() => document.activeElement?.blur());
  expect(await brightness()).toBe(25);
  expect((await labels(page)).length).toBe(steps.length + 1);
});

test('Align keeps a shape with an odd centred stroke inside the reference box, by the pixels it covers', async ({ page }) => {
  await newDoc(page, { width: 200, height: 120, background: 'white' });
  await page.evaluate(() => {
    const app = window.pigmentApp;
    app.tools.setOpt('shape-rect', 'strokeOn', true, { silent: true });
    app.tools.setOpt('shape-rect', 'strokeWidth', 3, { silent: true });
    app.tools.setOpt('shape-rect', 'strokeAlign', 'center', { silent: true });
    app.tools.activate('shape-rect');
    const t = app.tools.active;
    t.create(t.build({ x: 40, y: 30, width: 50, height: 40 }));
  });
  // the stroke is drawn from 38.5 to 91.5: it covers pixels 38 to 91
  const drawn = () => page.evaluate(async () => {
    const { shapeContentBounds } = await import('/lib/path-ops.js');
    const b = shapeContentBounds(window.pigmentApp.doc.active);
    return [b.x, b.y, b.x + b.width, b.y + b.height];
  });
  expect(await drawn()).toEqual([38.5, 28.5, 91.5, 71.5]);
  await runAwait(page, 'layer:align', 'right');
  await runAwait(page, 'layer:align', 'bottom');
  expect(await drawn()).toEqual([146.5, 76.5, 199.5, 119.5]); // the last covered pixel is the canvas's last one
  await runAwait(page, 'layer:align', 'left');
  await runAwait(page, 'layer:align', 'top');
  expect(await drawn()).toEqual([0.5, 0.5, 53.5, 43.5]); // the first covered pixel is the canvas's first one
  // and the composite has stroke pixels in the corner, none beyond the canvas to lose
  await runAwait(page, 'layer:align', 'right');
  const corner = await pixel(page, 199, 10);
  expect(corner[0]).toBeLessThan(255);
});
