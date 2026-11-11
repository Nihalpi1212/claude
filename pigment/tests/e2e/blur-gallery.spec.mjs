// Blur Gallery (lib/blur-gallery-ui.js): the on-canvas session of Field Blur, Iris Blur, Tilt-Shift,
// Path Blur and Spin Blur — pins, the blur ring, ellipse handles, tilt-shift lines, path points and
// speed arrows, the docked panel with its Effects and Noise tabs, reduced previews while dragging,
// one history entry on OK, Cancel restoring the pixels, and the committed params re-running to the
// same pixels through the plain filter command.
import { test, expect } from '@playwright/test';
import { openApp, newDoc, run, runAwait, drag, screenPoint, historyLength } from './helpers.mjs';

/** Paints a red / white checker with small dark squares into the active layer (no history entry) and keeps a copy. */
const paintPattern = (page) =>
  page.evaluate(() => {
    const app = window.pigmentApp, l = app.doc.active, c = l.canvas, ctx = c.getContext('2d');
    for (let y = 0; y < c.height; y += 20) {
      for (let x = 0; x < c.width; x += 20) {
        ctx.fillStyle = ((x + y) / 20) % 2 ? '#e03030' : '#ffffff';
        ctx.fillRect(x, y, 20, 20);
        ctx.fillStyle = '#102040';
        ctx.fillRect(x + 7, y + 7, 4, 4);
      }
    }
    l.touch();
    app.doc.changed('pixels');
    window.__orig = ctx.getImageData(0, 0, c.width, c.height);
  });

/** FNV-style hash of the active layer's pixels. */
const layerHash = (page) =>
  page.evaluate(() => {
    const c = window.pigmentApp.doc.active.canvas;
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let h = 2166136261;
    for (let i = 0; i < d.length; i++) h = Math.imul(h ^ d[i], 16777619);
    return h >>> 0;
  });

/** Largest difference between the active layer and the engine run on the kept original with params. */
const engineDiff = (page, kind, params) =>
  page.evaluate(async ([k, p]) => {
    const { applyFilter } = await import('/shared/pixels/filters.js');
    const o = window.__orig;
    const img = applyFilter({ width: o.width, height: o.height, data: new Uint8ClampedArray(o.data) }, k, p);
    const c = window.pigmentApp.doc.active.canvas;
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let max = 0;
    for (let i = 0; i < d.length; i++) max = Math.max(max, Math.abs(d[i] - img.data[i]));
    return max;
  }, [kind, params]);

const state = (page) =>
  page.evaluate(() => {
    const b = window.pigmentApp.blurGallery;
    return { active: b.active, kind: b.kind, params: b.params, selection: b.selection, rect: b.rect, shown: b.shown };
  });

const open = async (page, kind) => {
  await run(page, `filter:${kind}`);
  await expect(page.locator('.bg-panel')).toBeVisible();
  await expect(page.locator('.bg-panel')).toHaveAttribute('data-kind', kind);
};

const at = async (page, x, y) => screenPoint(page, x, y);
const dragScreen = async (page, a, b, { steps = 8, modifiers = [] } = {}) => {
  for (const m of modifiers) await page.keyboard.down(m);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps });
  await page.mouse.up();
  for (const m of modifiers) await page.keyboard.up(m);
};
/** Types a value into a field of the panel and confirms it (Enter hands the keys back to the canvas). */
const setField = async (page, key, value) => {
  const input = page.locator(`.bg-panel input[type="number"][data-key="${key}"]`);
  await input.fill(String(value));
  await input.press('Enter');
};
const committed = (page) => page.evaluate(() => window.pigmentApp.settings.lastFilter);
const near = (a, b, tol = 0.01) => Math.abs(a - b) <= tol;

test('Field Blur: drag the pin, change the blur, OK is one history entry of blurred pixels that the filter command reproduces', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  await paintPattern(page);
  const h0 = await historyLength(page), hash0 = await layerHash(page);
  await open(page, 'field-blur');
  // the session takes over: its own tool, its panel instead of the panel dock, one pin in the middle
  expect(await page.evaluate(() => window.pigmentApp.tools.active.id)).toBe('blur-gallery');
  await expect(page.locator('#panels')).toBeHidden();
  await expect(page.locator('.bg-panel .bg-title')).toHaveText('Field Blur');
  await expect(page.locator('.bg-panel .bg-pin-label')).toHaveText('Pin 1 of 1');
  let s = await state(page);
  expect(s.params.pins).toEqual([{ x: 0.5, y: 0.5, blur: 15 }]);
  expect(s.rect).toEqual({ x: 0, y: 0, width: 400, height: 300 });
  await expect.poll(() => layerHash(page)).not.toBe(hash0); // the preview is on the canvas
  // drag the pin
  await drag(page, [200, 150], [100, 81]);
  s = await state(page);
  expect(near(s.params.pins[0].x, 0.25) && near(s.params.pins[0].y, 0.27)).toBe(true);
  // change its blur in the panel
  await setField(page, 'blur', 12);
  expect((await state(page)).params.pins[0].blur).toBe(12);
  // a click on the image adds a pin with the same settings and selects it; make that one sharp
  const p2 = await at(page, 300, 220);
  await page.mouse.click(p2.x, p2.y);
  await expect(page.locator('.bg-panel .bg-pin-label')).toHaveText('Pin 2 of 2');
  s = await state(page);
  expect(s.params.pins.length).toBe(2);
  expect(s.params.pins[1].blur).toBe(12);
  expect(s.selection).toEqual({ pin: 1 });
  await setField(page, 'blur', 0);
  // the preview is exactly what the engine makes of the current params (a small layer previews at full quality)
  await expect.poll(async () => (await state(page)).shown).toEqual({ full: true, current: true });
  s = await state(page);
  expect(await engineDiff(page, 'field-blur', s.params)).toBe(0);
  expect(await historyLength(page)).toBe(h0); // nothing recorded yet
  // OK
  await page.locator('.bg-panel [data-action="ok"]').click();
  await expect(page.locator('.bg-panel')).toHaveCount(0);
  await expect(page.locator('#panels')).toBeVisible();
  expect(await page.evaluate(() => window.pigmentApp.tools.active.id)).toBe('move');
  expect(await historyLength(page)).toBe(h0 + 1);
  expect(await page.evaluate(() => window.pigmentApp.doc.history.entries.at(-1).label)).toBe('Field Blur');
  const last = await committed(page);
  expect(last.kind).toBe('field-blur');
  expect(last.params).toEqual(s.params);
  const hash1 = await layerHash(page);
  expect(hash1).not.toBe(hash0);
  expect(await engineDiff(page, 'field-blur', last.params)).toBe(0);
  // sharp under the 0 px pin, blurred under the 12 px pin (a white square of the checker turned pinkish)
  const px = (x, y) => page.evaluate(([a, b]) => Array.from(window.pigmentApp.doc.active.canvas.getContext('2d').getImageData(a, b, 1, 1).data), [x, y]);
  expect(await px(300, 220)).toEqual(await page.evaluate(() => Array.from(window.__orig.data.slice((220 * 400 + 300) * 4, (220 * 400 + 300) * 4 + 4))));
  const blurred = await px(103, 83);
  expect(blurred[1]).toBeGreaterThan(90);
  expect(blurred[1]).toBeLessThan(215);
  // undo restores; the plain filter command with the committed params gives the same pixels, as does Last Filter
  await runAwait(page, 'edit:undo');
  expect(await layerHash(page)).toBe(hash0);
  await runAwait(page, 'filter:field-blur', last.params);
  expect(await layerHash(page)).toBe(hash1);
  expect(await historyLength(page)).toBe(h0 + 1);
  await runAwait(page, 'edit:undo');
  await runAwait(page, 'filter:last');
  expect(await layerHash(page)).toBe(hash1);
  expect(errors).toEqual([]);
});

test('Cancel and Escape restore the pixels and leave no history entry', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  await paintPattern(page);
  const h0 = await historyLength(page), hash0 = await layerHash(page);
  await page.evaluate(() => window.pigmentApp.tools.activate('brush'));
  for (const leave of [
    () => page.keyboard.press('Escape'),
    () => page.locator('.bg-panel [data-action="cancel"]').click(),
    () => page.locator('#options-bar [data-action="cancel"]').click(),
  ]) {
    await open(page, 'field-blur');
    await drag(page, [200, 150], [260, 100]);
    await setField(page, 'blur', 30);
    await expect.poll(() => layerHash(page)).not.toBe(hash0);
    await leave();
    await expect(page.locator('.bg-panel')).toHaveCount(0);
    expect(await layerHash(page)).toBe(hash0);
    expect(await historyLength(page)).toBe(h0);
    expect((await state(page)).active).toBe(false);
    // the tool that was active before comes back, and the session's tool is not a toolbox tool
    expect(await page.evaluate(() => window.pigmentApp.tools.active.id)).toBe('brush');
    expect(await page.evaluate(() => window.pigmentApp.tools.tools.has('blur-gallery'))).toBe(false);
  }
  expect(await committed(page)).toBeFalsy();
  // a cancelled session does not remember its pins: the next one starts from the defaults again
  await open(page, 'field-blur');
  expect((await state(page)).params.pins).toEqual([{ x: 0.5, y: 0.5, blur: 15 }]);
  await page.keyboard.press('Escape');
  expect(errors).toEqual([]);
});

test('the ring sets the blur, Delete removes the pin, arrows nudge it, P toggles the preview, Reset starts over', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  await paintPattern(page);
  const hash0 = await layerHash(page);
  await open(page, 'field-blur');
  // a quarter turn clockwise on the ring (30 px around the pin) adds a quarter of 100 px
  const c = await at(page, 200, 150);
  await dragScreen(page, { x: c.x, y: c.y - 30 }, { x: c.x + 30, y: c.y }, { steps: 12 });
  let s = await state(page);
  expect(s.params.pins.length).toBe(1);
  expect(Math.abs(s.params.pins[0].blur - 40)).toBeLessThanOrEqual(1);
  await expect(page.locator('.bg-panel input[type="number"][data-key="blur"]')).toHaveValue(String(s.params.pins[0].blur));
  // and back, anticlockwise, down to zero
  await dragScreen(page, { x: c.x + 30, y: c.y }, { x: c.x - 30, y: c.y - 2 }, { steps: 16 });
  expect((await state(page)).params.pins[0].blur).toBe(0);
  await expect.poll(() => layerHash(page)).toBe(hash0);
  await setField(page, 'blur', 20);
  await expect.poll(() => layerHash(page)).not.toBe(hash0);
  // arrows move the pin by a pixel (Shift: ten)
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Shift+ArrowDown');
  s = await state(page);
  expect(near(s.params.pins[0].x, 201 / 400, 1e-6) && near(s.params.pins[0].y, 160 / 300, 1e-6)).toBe(true);
  // P hides and shows the preview without ending the session
  await page.keyboard.press('p');
  await expect(page.locator('.bg-panel [data-key="__preview"]')).not.toBeChecked();
  await expect.poll(() => layerHash(page)).toBe(hash0);
  await page.locator('.bg-panel [data-key="__preview"]').check();
  await expect.poll(() => layerHash(page)).not.toBe(hash0);
  // a second pin, then Delete removes the selected one (the new one), then the first
  const q = await at(page, 60, 60);
  await page.mouse.click(q.x, q.y);
  expect((await state(page)).params.pins.length).toBe(2);
  await page.keyboard.press('Delete');
  s = await state(page);
  expect(s.params.pins.length).toBe(1);
  expect(s.selection).toEqual({ pin: 0 });
  await page.locator('.bg-panel [data-action="remove"]').click();
  expect((await state(page)).params.pins).toEqual([]);
  await expect(page.locator('.bg-panel .bg-pin-label')).toContainText('No pin');
  await expect(page.locator('.bg-panel [data-action="remove"]')).toBeDisabled();
  await expect(page.locator('.bg-panel input[type="number"][data-key="blur"]')).toBeDisabled();
  await expect.poll(() => layerHash(page)).toBe(hash0); // no pin, no blur
  // Reset brings the default pin back
  await page.locator('.bg-panel [data-action="reset"]').click();
  expect((await state(page)).params.pins).toEqual([{ x: 0.5, y: 0.5, blur: 15 }]);
  await page.keyboard.press('Escape');
  await expect(page.locator('.bg-panel')).toHaveCount(0);
  expect(await layerHash(page)).toBe(hash0);
  expect(errors).toEqual([]);
});

test('Iris Blur: ellipse handles set the radii and the rotation, inner dots the sharp area, the square the roundness', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  await paintPattern(page);
  const h0 = await historyLength(page);
  await open(page, 'iris-blur');
  // default: centre (200, 150), radii 120 x 90
  await drag(page, [320, 150], [350, 150], { modifiers: ['Shift'] }); // right handle, Shift: size only
  let pin = (await state(page)).params.pins[0];
  expect(near(pin.rx, 150 / 400, 0.004) && pin.rotation === 0 && near(pin.ry, 0.3, 1e-9)).toBe(true);
  // without Shift the handle also turns the ellipse: the bottom handle dragged to the lower left
  await drag(page, [200, 240], [140, 210]);
  pin = (await state(page)).params.pins[0];
  expect(near(pin.ry, Math.hypot(60, 60) / 300, 0.006)).toBe(true);
  expect(Math.abs(pin.rotation - 45)).toBeLessThan(1.5);
  await setField(page, 'rotation', 0);
  await setField(page, 'ry', 30); // percent of the height
  pin = (await state(page)).params.pins[0];
  expect(pin.rotation === 0 && near(pin.ry, 0.3, 1e-9)).toBe(true);
  // the inner dot on the top axis (at 50 % of 90 px) dragged out to 72 px: sharp area 80 %
  await drag(page, [200, 105], [200, 78]);
  pin = (await state(page)).params.pins[0];
  expect(near(pin.feather, 0.8, 0.02)).toBe(true);
  // the square on the diagonal dragged outwards: the ellipse becomes a rounded rectangle
  const t = Math.SQRT1_2;
  await drag(page, [200 + 150 * t, 150 + 90 * t], [200 + 150 * 0.9, 150 + 90 * 0.9]);
  pin = (await state(page)).params.pins[0];
  expect(pin.roundness).toBeGreaterThan(60);
  // the ring sets the blur here too
  const c = await at(page, 200, 150);
  await dragScreen(page, { x: c.x, y: c.y - 30 }, { x: c.x + 30, y: c.y }, { steps: 12 });
  pin = (await state(page)).params.pins[0];
  expect(Math.abs(pin.blur - 40)).toBeLessThanOrEqual(1);
  // moving the pin moves the whole iris
  await drag(page, [200, 150], [180, 140]);
  pin = (await state(page)).params.pins[0];
  expect(near(pin.x, 0.45, 0.004) && near(pin.y, 140 / 300, 0.004)).toBe(true);
  await page.keyboard.press('Enter');
  await expect(page.locator('.bg-panel')).toHaveCount(0);
  expect(await historyLength(page)).toBe(h0 + 1);
  const last = await committed(page);
  expect(last.kind).toBe('iris-blur');
  expect(last.params.pins[0]).toEqual(pin);
  expect(await engineDiff(page, 'iris-blur', last.params)).toBe(0);
  // sharp in the middle, blurred in the corner
  const same = (x, y) => page.evaluate(([a, b]) => {
    const d = window.pigmentApp.doc.active.canvas.getContext('2d').getImageData(a, b, 1, 1).data, o = window.__orig.data, i = (b * 400 + a) * 4;
    return d[0] === o[i] && d[1] === o[i + 1] && d[2] === o[i + 2];
  }, [x, y]);
  expect(await same(180, 140)).toBe(true);
  expect(await same(9, 9)).toBe(false);
  expect(errors).toEqual([]);
});

test('Tilt-Shift: the lines set focus and transition, the dots rotate the band, distortion lives in the panel', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  await paintPattern(page);
  const h0 = await historyLength(page);
  await open(page, 'tilt-shift');
  // default: band through (200, 150), focus 15 % (45 px), transition 30 % (90 px)
  await drag(page, [90, 195], [90, 180]); // the solid line below the pin
  let pin = (await state(page)).params.pins[0];
  expect(near(pin.focus, 0.1, 0.004)).toBe(true);
  await drag(page, [310, 150 - 30 - 90], [310, 150 - 30 - 45]); // the dashed line above
  pin = (await state(page)).params.pins[0];
  expect(near(pin.fade, 0.15, 0.004) && near(pin.focus, 0.1, 0.004)).toBe(true);
  // the dot on the lower solid line dragged to the right of the pin: the band turns by -90 degrees
  await drag(page, [200, 180], [250, 150]);
  pin = (await state(page)).params.pins[0];
  expect(pin.rotation).toBe(-90);
  await setField(page, 'rotation', 20);
  await setField(page, 'distortion', 40);
  await page.locator('.bg-panel input[data-key="symmetricDistortion"]').check();
  const s = await state(page);
  expect(s.params.distortion).toBe(40);
  expect(s.params.symmetricDistortion).toBe(true);
  expect(s.params.pins[0].rotation).toBe(20);
  // a second band elsewhere
  const q = await at(page, 60, 250);
  await page.mouse.click(q.x, q.y);
  expect((await state(page)).params.pins.length).toBe(2);
  await page.locator('#options-bar [data-action="ok"]').click();
  await expect(page.locator('.bg-panel')).toHaveCount(0);
  expect(await historyLength(page)).toBe(h0 + 1);
  const last = await committed(page);
  expect(last.kind).toBe('tilt-shift');
  expect(last.params.pins.length).toBe(2);
  expect(await engineDiff(page, 'tilt-shift', last.params)).toBe(0);
  expect(errors).toEqual([]);
});

test('Path Blur: points, speed arrows, new points on the path, new paths, Delete', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  await paintPattern(page);
  const h0 = await historyLength(page), hash0 = await layerHash(page);
  await open(page, 'path-blur');
  await expect(page.locator('.bg-panel .bg-pin-label')).toHaveText('Path 1 of 1');
  // default path: (120, 150) to (280, 150); drag its end point up
  await drag(page, [280, 150], [280, 90]);
  let s = await state(page);
  expect(near(s.params.paths[0].points[1].x, 0.7, 0.004) && near(s.params.paths[0].points[1].y, 0.3, 0.004)).toBe(true);
  expect(s.selection).toEqual({ path: 0, point: 1 });
  // the end arrow: its knob sits 18 + 50 * 0.5 screen px beyond the end point, along the path
  const end = await at(page, 280, 90), dir = { x: 160 / Math.hypot(160, 60), y: -60 / Math.hypot(160, 60) };
  const zoom = await page.evaluate(() => window.pigmentApp.view.zoom);
  const ux = dir.x, uy = dir.y; // the view is not rotated: screen and document directions agree
  await dragScreen(page, { x: end.x + ux * 43, y: end.y + uy * 43 }, { x: end.x + ux * 98, y: end.y + uy * 98 });
  s = await state(page);
  expect(Math.abs(s.params.paths[0].endSpeeds[1] - 160)).toBeLessThanOrEqual(3);
  expect(s.params.paths[0].endSpeeds[0]).toBe(50);
  await expect(page.locator('.bg-panel input[type="number"][data-key="endSpeeds.1"]')).toHaveValue(String(s.params.paths[0].endSpeeds[1]));
  expect(zoom).toBeGreaterThan(0);
  // a press on the path adds a point there and drags it: the line becomes a curve through three points
  await drag(page, [200, 120], [200, 200]);
  s = await state(page);
  expect(s.params.paths[0].points.length).toBe(3);
  expect(near(s.params.paths[0].points[1].y, 200 / 300, 0.01)).toBe(true);
  expect(s.selection).toEqual({ path: 0, point: 1 });
  // Delete removes that point again
  await page.keyboard.press('Delete');
  s = await state(page);
  expect(s.params.paths[0].points.length).toBe(2);
  // dragging on the image draws a second path; a plain click makes a short horizontal one
  await drag(page, [60, 250], [160, 270]);
  s = await state(page);
  expect(s.params.paths.length).toBe(2);
  expect(near(s.params.paths[1].points[0].x, 0.15, 0.004) && near(s.params.paths[1].points[1].y, 0.9, 0.004)).toBe(true);
  expect(s.params.paths[1].endSpeeds).toEqual(s.params.paths[0].endSpeeds); // a new path takes the selected one's speeds
  await expect(page.locator('.bg-panel .bg-pin-label')).toHaveText('Path 2 of 2');
  const q = await at(page, 300, 250);
  await page.mouse.click(q.x, q.y);
  s = await state(page);
  expect(s.params.paths.length).toBe(3);
  expect(near(s.params.paths[2].points[0].x, 0.6, 0.004) && near(s.params.paths[2].points[1].x, 0.9, 0.004) && s.params.paths[2].points[0].y === s.params.paths[2].points[1].y).toBe(true);
  // with no point selected Delete removes the whole path
  expect(s.selection).toEqual({ path: 2, point: -1 });
  await page.keyboard.press('Delete');
  expect((await state(page)).params.paths.length).toBe(2);
  // the panel: speed, taper and the strobe on the Motion Effects tab
  await setField(page, 'speed', 80);
  await setField(page, 'taper', 30);
  await page.locator('.bg-panel [data-tab="effects"]').click();
  await expect(page.locator('.bg-panel [data-pane="effects"]')).toBeVisible();
  await expect(page.locator('.bg-panel [data-pane="blur"]')).toBeHidden();
  await page.locator('.bg-panel input[data-key="strobe"]').check();
  await setField(page, 'strobeFlashes', 3);
  s = await state(page);
  expect([s.params.speed, s.params.taper, s.params.strobe, s.params.strobeFlashes]).toEqual([80, 30, true, 3]);
  await page.keyboard.press('Enter');
  await expect(page.locator('.bg-panel')).toHaveCount(0);
  expect(await historyLength(page)).toBe(h0 + 1);
  const last = await committed(page);
  expect(last.kind).toBe('path-blur');
  expect(last.params).toEqual(s.params);
  expect(await engineDiff(page, 'path-blur', last.params)).toBe(0);
  const hash1 = await layerHash(page);
  await runAwait(page, 'edit:undo');
  expect(await layerHash(page)).toBe(hash0);
  await runAwait(page, 'filter:path-blur', last.params);
  expect(await layerHash(page)).toBe(hash1);
  expect(errors).toEqual([]);
});

test('Spin Blur: the ring is the blur angle, the handles shape the ellipse, the Noise tab adds grain', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  await paintPattern(page);
  const h0 = await historyLength(page);
  await open(page, 'spin-blur');
  await expect(page.locator('.bg-panel [data-tab="effects"]')).toHaveText('Motion Effects');
  const c = await at(page, 200, 150);
  await dragScreen(page, { x: c.x, y: c.y - 30 }, { x: c.x + 30, y: c.y }, { steps: 12 }); // a quarter turn: +90 degrees
  let pin = (await state(page)).params.pins[0];
  expect(Math.abs(pin.angle - 105)).toBeLessThanOrEqual(2);
  await drag(page, [80, 150], [110, 150], { modifiers: ['Shift'] }); // the left handle
  await drag(page, [200, 105], [200, 150 - 81]); // the inner dot on the top axis: full strength up to 90 %
  pin = (await state(page)).params.pins[0];
  expect(near(pin.rx, 90 / 400, 0.004) && near(pin.feather, 0.9, 0.02) && pin.rotation === 0).toBe(true);
  // the Noise tab
  await page.locator('.bg-panel [data-tab="noise"]').click();
  await setField(page, 'noise.amount', 60);
  await setField(page, 'noise.size', 2);
  await setField(page, 'noise.color', 100);
  await page.locator('.bg-panel [data-pane="noise"] [data-value="uniform"]').click();
  const s = await state(page);
  expect(s.params.noise).toEqual({ amount: 60, size: 2, roughness: 0, color: 100, highlights: 0, distribution: 'uniform' });
  await page.locator('.bg-panel [data-action="ok"]').click();
  await expect(page.locator('.bg-panel')).toHaveCount(0);
  expect(await historyLength(page)).toBe(h0 + 1);
  const last = await committed(page);
  expect(last.params).toEqual(s.params);
  expect(await engineDiff(page, 'spin-blur', last.params)).toBe(0);
  expect(errors).toEqual([]);
});

test('Effects tab: bokeh is part of the committed params and brightens blurred highlights', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  await page.evaluate(() => {
    const app = window.pigmentApp, l = app.doc.active, ctx = l.canvas.getContext('2d');
    ctx.fillStyle = '#303030';
    ctx.fillRect(0, 0, 400, 300);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(196, 146, 8, 8); // one small light
    l.touch();
    app.doc.changed('pixels');
    window.__orig = ctx.getImageData(0, 0, 400, 300);
  });
  const light = () => page.evaluate(() => window.pigmentApp.doc.active.canvas.getContext('2d').getImageData(200, 162, 1, 1).data[0]);
  await open(page, 'field-blur');
  await setField(page, 'blur', 8);
  await expect.poll(async () => (await state(page)).shown.full).toBe(true);
  const plain = await light();
  await page.locator('.bg-panel [data-tab="effects"]').click();
  await setField(page, 'bokeh.lightBokeh', 80);
  await setField(page, 'bokeh.bokehColor', 20);
  await setField(page, 'bokeh.lightRange.0', 200);
  await expect.poll(async () => (await state(page)).shown).toEqual({ full: true, current: true });
  expect(await light()).toBeGreaterThan(plain + 25);
  // the two ends of the light range cannot cross
  await setField(page, 'bokeh.lightRange.1', 150);
  let s = await state(page);
  expect(s.params.bokeh.lightRange).toEqual([150, 150]);
  await setField(page, 'bokeh.lightRange.1', 255);
  await setField(page, 'bokeh.lightRange.0', 200);
  s = await state(page);
  expect(s.params.bokeh).toEqual({ lightBokeh: 80, bokehColor: 20, lightRange: [200, 255] });
  await page.keyboard.press('Enter');
  await expect(page.locator('.bg-panel')).toHaveCount(0);
  const last = await committed(page);
  expect(last.params.bokeh).toEqual({ lightBokeh: 80, bokehColor: 20, lightRange: [200, 255] });
  expect(await engineDiff(page, 'field-blur', last.params)).toBe(0);
  // the settings are remembered for the next session of the kind
  await open(page, 'field-blur');
  expect((await state(page)).params.bokeh).toEqual({ lightBokeh: 80, bokehColor: 20, lightRange: [200, 255] });
  await page.keyboard.press('Escape');
  expect(errors).toEqual([]);
});

test('a large layer previews on a reduced copy while dragging and at full quality after the release and on OK', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 1600, height: 1200 });
  await paintPattern(page);
  const h0 = await historyLength(page);
  await open(page, 'iris-blur');
  // the first look is the reduced preview, the full-quality one follows by itself
  await expect.poll(async () => (await state(page)).shown, { timeout: 30_000 }).toEqual({ full: true, current: true });
  expect(await engineDiff(page, 'iris-blur', (await state(page)).params)).toBe(0);
  // while the pin is held the preview follows on the reduced copy
  const a = await at(page, 800, 600), b = await at(page, 500, 450);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 4 });
  await expect.poll(async () => (await state(page)).shown).toEqual({ full: false, current: true });
  await page.mouse.move(b.x, b.y, { steps: 4 });
  await page.waitForTimeout(500); // longer than the settle delay: nothing settles while the button is down
  expect((await state(page)).shown.full).toBe(false);
  const rough = await engineDiff(page, 'iris-blur', (await state(page)).params);
  expect(rough).toBeGreaterThan(0); // an approximation ...
  await page.mouse.up();
  await expect.poll(async () => (await state(page)).shown, { timeout: 30_000 }).toEqual({ full: true, current: true });
  let s = await state(page);
  expect(near(s.params.pins[0].x, 500 / 1600, 0.003) && near(s.params.pins[0].y, 450 / 1200, 0.003)).toBe(true);
  expect(await engineDiff(page, 'iris-blur', s.params)).toBe(0); // ... replaced by the real thing
  expect(await historyLength(page)).toBe(h0);
  // OK right after a change (the reduced preview is still up) commits the full-quality result
  await setField(page, 'blur', 33);
  s = await state(page);
  await page.keyboard.press('Enter');
  await expect(page.locator('.bg-panel')).toHaveCount(0, { timeout: 30_000 });
  expect(await historyLength(page)).toBe(h0 + 1);
  const last = await committed(page);
  expect(last.params).toEqual(s.params);
  expect(last.params.pins[0].blur).toBe(33);
  expect(await engineDiff(page, 'iris-blur', last.params)).toBe(0);
  expect(errors).toEqual([]);
});

test('Escape while a reduced preview is on a large layer restores every pixel; the controls can be hidden with H', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 1200, height: 900 });
  await paintPattern(page);
  const h0 = await historyLength(page), hash0 = await layerHash(page);
  for (const kind of ['field-blur', 'spin-blur']) {
    await open(page, kind);
    await expect.poll(async () => (await state(page)).shown, { timeout: 30_000 }).toEqual({ full: true, current: true });
    // several reduced previews in a row (they are scaled straight into the layer), then out while one is up
    const a = await at(page, 600, 450), b = await at(page, 300, 250);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 6 });
    await expect.poll(async () => (await state(page)).shown).toEqual({ full: false, current: true });
    expect(await layerHash(page)).not.toBe(hash0);
    await page.mouse.up();
    await page.keyboard.press('Escape');
    await expect(page.locator('.bg-panel')).toHaveCount(0);
    expect(await layerHash(page)).toBe(hash0);
    expect(await historyLength(page)).toBe(h0);
  }
  // P (preview off) puts the original back too, and on again shows the blur; H hides the pins without ending anything
  await open(page, 'field-blur');
  await expect.poll(async () => (await state(page)).shown, { timeout: 30_000 }).toEqual({ full: true, current: true });
  await drag(page, [600, 450], [500, 400]);
  await page.keyboard.press('p');
  await expect.poll(() => layerHash(page)).toBe(hash0);
  await page.keyboard.press('p');
  await expect.poll(async () => (await state(page)).shown, { timeout: 30_000 }).toEqual({ full: true, current: true });
  expect(await engineDiff(page, 'field-blur', (await state(page)).params)).toBe(0);
  await page.keyboard.press('h');
  const q = await at(page, 200, 200);
  await page.mouse.click(q.x, q.y); // hidden controls take no clicks: no pin is added
  expect((await state(page)).params.pins.length).toBe(1);
  await page.keyboard.press('h');
  await page.mouse.click(q.x, q.y);
  expect((await state(page)).params.pins.length).toBe(2);
  await page.keyboard.press('Escape');
  expect(await layerHash(page)).toBe(hash0);
  expect(errors).toEqual([]);
});

test('the session owns the document: other commands and tool shortcuts wait until it ends', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  await paintPattern(page);
  await runAwait(page, 'filter:gaussian-blur', { radius: 2 }); // something to undo
  const h0 = await historyLength(page), hash0 = await layerHash(page);
  await open(page, 'field-blur');
  await setField(page, 'blur', 25);
  await expect.poll(() => layerHash(page)).not.toBe(hash0);
  const preview = await layerHash(page);
  // undo, another filter, a tool command, a tool key, a new layer: none of them runs
  await runAwait(page, 'edit:undo');
  await runAwait(page, 'filter:gaussian-blur', { radius: 9 });
  await runAwait(page, 'tool:brush');
  await runAwait(page, 'layer:new');
  await run(page, 'filter:iris-blur');
  await page.keyboard.press('b');
  await page.keyboard.press('Control+z');
  expect(await page.evaluate(() => window.pigmentApp.tools.active.id)).toBe('blur-gallery');
  expect(await historyLength(page)).toBe(h0);
  expect(await page.evaluate(() => window.pigmentApp.doc.root.children.length)).toBe(1);
  expect(await layerHash(page)).toBe(preview);
  expect((await state(page)).kind).toBe('field-blur');
  // the toolbox and the tabs do not take clicks
  expect(await page.evaluate(() => getComputedStyle(document.getElementById('toolbox')).pointerEvents)).toBe('none');
  expect(await page.evaluate(() => getComputedStyle(document.getElementById('tabbar')).pointerEvents)).toBe('none');
  // the view still zooms and scrolls, and the pins follow
  const z0 = await page.evaluate(() => window.pigmentApp.view.zoom);
  await runAwait(page, 'view:zoom-in');
  expect(await page.evaluate(() => window.pigmentApp.view.zoom)).toBeGreaterThan(z0);
  await drag(page, [200, 150], [120, 110]);
  const s = await state(page);
  expect(near(s.params.pins[0].x, 0.3, 0.005) && near(s.params.pins[0].y, 110 / 300, 0.005)).toBe(true);
  // switching the tool behind the session's back cancels it cleanly
  await page.evaluate(() => window.pigmentApp.tools.activate('move'));
  await expect(page.locator('.bg-panel')).toHaveCount(0);
  expect(await layerHash(page)).toBe(hash0);
  expect(await historyLength(page)).toBe(h0);
  // and everything works again
  expect(await page.evaluate(() => getComputedStyle(document.getElementById('toolbox')).pointerEvents)).not.toBe('none');
  await runAwait(page, 'edit:undo');
  expect(await historyLength(page)).toBe(h0 - 1);
  expect(errors).toEqual([]);
});

test('with a selection the blur stays inside it and the pins are placed within its bounds', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  await paintPattern(page);
  await page.keyboard.press('m');
  await drag(page, [100, 60], [300, 220]);
  expect(await page.evaluate(() => window.pigmentApp.doc.selection?.bounds)).toMatchObject({ x: 100, y: 60, width: 200, height: 160 });
  const h0 = await historyLength(page);
  await open(page, 'field-blur');
  let s = await state(page);
  expect(s.rect).toEqual({ x: 100, y: 60, width: 200, height: 160 });
  // the default pin sits in the middle of the selection; dragging it by 50 px is a quarter of the selection's width
  await drag(page, [200, 140], [250, 140]);
  s = await state(page);
  expect(near(s.params.pins[0].x, 0.75, 0.006) && near(s.params.pins[0].y, 0.5, 0.006)).toBe(true);
  // a click outside the selection adds nothing
  const out = await at(page, 40, 30);
  await page.mouse.click(out.x, out.y);
  expect((await state(page)).params.pins.length).toBe(1);
  await setField(page, 'blur', 10);
  await page.keyboard.press('Enter');
  await expect(page.locator('.bg-panel')).toHaveCount(0);
  expect(await historyLength(page)).toBe(h0 + 1);
  const changed = await page.evaluate(() => {
    const c = window.pigmentApp.doc.active.canvas, d = c.getContext('2d').getImageData(0, 0, 400, 300).data, o = window.__orig.data;
    let inside = 0, outside = 0;
    for (let y = 0; y < 300; y++) for (let x = 0; x < 400; x++) {
      const i = (y * 400 + x) * 4;
      if (d[i] === o[i] && d[i + 1] === o[i + 1] && d[i + 2] === o[i + 2]) continue;
      if (x >= 100 && x < 300 && y >= 60 && y < 220) inside++;
      else outside++;
    }
    return { inside, outside };
  });
  expect(changed.outside).toBe(0);
  expect(changed.inside).toBeGreaterThan(20000);
  // the committed params replay to the same pixels with the same selection
  const last = await committed(page);
  const hash1 = await layerHash(page);
  await runAwait(page, 'edit:undo');
  await runAwait(page, 'filter:field-blur', last.params);
  expect(await layerHash(page)).toBe(hash1);
  expect(errors).toEqual([]);
});

test('on a smart object the session edits a smart filter that renders what the session showed', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  await paintPattern(page);
  await runAwait(page, 'layer:smart-convert');
  expect(await page.evaluate(() => window.pigmentApp.doc.active.type)).toBe('smart');
  const h0 = await historyLength(page);
  await open(page, 'tilt-shift');
  await setField(page, 'blur', 9);
  await drag(page, [200, 150], [200, 100]);
  const s = await state(page);
  await page.keyboard.press('Enter');
  await expect(page.locator('.bg-panel')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.pigmentApp.doc.active.filters?.length)).toBe(1);
  const info = await page.evaluate(() => {
    const d = window.pigmentApp.doc, l = d.active;
    return { type: l.type, layers: d.root.children.length, filter: l.filters[0] };
  });
  expect(info.type).toBe('smart');
  expect(info.layers).toBe(1); // the temporary copy the session ran on is gone
  expect(info.filter.kind).toBe('tilt-shift');
  expect(info.filter.params).toEqual(s.params);
  expect(await historyLength(page)).toBe(h0 + 1);
  // the smart filter renders the engine's result for those params
  const diff = await page.evaluate(async (p) => {
    const { applyFilter } = await import('/shared/pixels/filters.js');
    const o = window.__orig;
    const img = applyFilter({ width: o.width, height: o.height, data: new Uint8ClampedArray(o.data) }, 'tilt-shift', p);
    const d = window.pigmentApp.doc;
    const c = d.view.compositor.composite(d).getContext('2d', { willReadFrequently: true }).getImageData(0, 0, 400, 300).data;
    let max = 0;
    for (let i = 0; i < c.length; i++) max = Math.max(max, Math.abs(c[i] - img.data[i]));
    return max;
  }, s.params);
  expect(diff).toBeLessThanOrEqual(1);
  await runAwait(page, 'edit:undo');
  expect(await page.evaluate(() => window.pigmentApp.doc.active.filters.length)).toBe(0);
  expect(errors).toEqual([]);
});
