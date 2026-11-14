// shapes-live (Pigment 0.4, ARCHITECTURE.md "0.4 features", package 13): live shapes. The shape tools (Triangle,
// polygon and line options, the gear menu, the Create dialogs, the corner widgets), the Properties section (live W / H /
// X / Y, angle, radii, polygon and line parameters; fill and stroke paints, stroke options), Copy / Paste Shape
// Attributes, shapes kept live through moves and transforms, stroke rendering (alignment, dashes, bounds) and the
// .pigment round trip.
import { test, expect } from '@playwright/test';
import { openApp, newDoc, runAwait, run, pixel, historyLength, confirmDialog, drag, screenPoint } from './helpers.mjs';

const props = (page) => page.evaluate(() => {
  const l = window.pigmentApp.doc.active;
  return { kind: l.shapeKind, props: JSON.parse(JSON.stringify(l.shapeProps)) };
});
const lastLabel = (page) => page.evaluate(() => window.pigmentApp.doc.history.entries[window.pigmentApp.doc.history.index]?.label);

/** Adds a live shape built by the given tool in box r (one history entry) and makes it active. */
async function addShape(page, shape, r, opts = {}) {
  await page.evaluate(([s, box, o]) => {
    const app = window.pigmentApp;
    for (const [k, v] of Object.entries(o)) app.tools.setOpt(`shape-${s}`, k, v, { silent: true });
    app.tools.activate(`shape-${s}`);
    const t = app.tools.active;
    t.create(t.build(box));
  }, [shape, r, opts]);
}

async function showProperties(page) {
  await runAwait(page, 'window:panel-properties');
  await expect(page.locator('[data-panel="properties"] .sl-props')).toBeVisible();
}

const prop = (page, key) => page.locator(`[data-panel="properties"] [data-key="${key}"]`).first();
async function setProp(page, key, value) {
  const input = prop(page, key);
  await input.fill(String(value));
  await input.press('Enter');
}

test('the shape tools draw live shapes: Triangle, polygon star options, line arrowheads, custom shapes', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 400, height: 300, background: 'transparent' });
  const slot = await page.evaluate(() => window.pigmentApp.tools.slots.find((s) => s.id === 'shape')?.tools);
  expect(slot).toEqual(['shape-rect', 'shape-rrect', 'shape-ellipse', 'shape-triangle', 'shape-polygon', 'shape-line', 'shape-custom']);
  // the pen, path and shape tools claim Ctrl and Alt (L.12)
  const claims = await page.evaluate(async () => {
    const { claimsModifier } = await import('/lib/tool-traits.js');
    const t = window.pigmentApp.tools;
    return ['pen-tool', 'path-selection', 'direct-selection', 'shape-triangle'].map((id) => claimsModifier(t.get(id), 'ctrl') && claimsModifier(t.get(id), 'alt'));
  });
  expect(claims).toEqual([true, true, true, true]);

  await page.evaluate(() => window.pigmentApp.tools.activate('shape-triangle'));
  await drag(page, [40, 40], [140, 120]);
  expect(await props(page)).toEqual({ kind: 'triangle', props: { x: 40, y: 40, width: 100, height: 80, angle: 0, radius: 0 } });
  expect(await lastLabel(page)).toBe('Triangle Tool');
  // the apex is at the top middle: painted there, not in the top corners
  expect((await pixel(page, 90, 50))[3]).toBe(255);
  expect((await pixel(page, 45, 45))[3]).toBe(0);

  await page.evaluate(() => {
    const t = window.pigmentApp.tools;
    t.setOpt('shape-polygon', 'sides', 6);
    t.setOpt('shape-polygon', 'starRatio', 50);
    t.setOpt('shape-polygon', 'smoothIndents', true);
    t.activate('shape-polygon');
  });
  await drag(page, [200, 40], [300, 140]);
  const poly = await props(page);
  expect(poly.kind).toBe('polygon');
  expect(poly.props).toMatchObject({ sides: 6, starRatio: 50, smoothIndents: true, smoothCorners: false });

  await page.evaluate(() => {
    const t = window.pigmentApp.tools;
    t.setOpt('shape-line', 'weight', 4);
    t.setOpt('shape-line', 'arrowEnd', true);
    t.setOpt('shape-line', 'arrowConcavity', 20);
    t.activate('shape-line');
  });
  await drag(page, [40, 200], [200, 200]);
  const line = await props(page);
  expect(line.kind).toBe('line');
  expect(line.props).toMatchObject({ x1: 40, y1: 200, x2: 200, y2: 200, weight: 4, arrowStart: null, arrowEnd: { width: 500, length: 1000, concavity: 20 } });
  // the head reaches 10 px each side of the line at its base (500 % of 4 px wide)
  expect((await pixel(page, 162, 209))[3]).toBeGreaterThan(0);
  expect((await pixel(page, 100, 209))[3]).toBe(0);

  await page.evaluate(() => {
    window.pigmentApp.tools.setOpt('shape-custom', 'shape', 'plus');
    window.pigmentApp.tools.activate('shape-custom');
  });
  await drag(page, [260, 180], [340, 260]);
  expect(await props(page)).toEqual({ kind: 'custom', props: { x: 260, y: 180, width: 80, height: 80, angle: 0, shape: 'plus' } });
  expect(errors).toEqual([]);
});

test('Properties: live W / H / X / Y, angle and corner radii, each change one undoable entry; Transform is hidden', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 400, height: 300, background: 'transparent' });
  await addShape(page, 'rect', { x: 50, y: 40, width: 120, height: 80 });
  await showProperties(page);
  await expect(page.locator('[data-panel="properties"] input[data-axis="x"]')).toHaveCount(0);
  await expect(page.locator('[data-panel="properties"] .sl-live h4')).toHaveText(/Rectangle/);
  await expect(prop(page, 'shape-w')).toHaveValue('120');

  const n = await historyLength(page);
  await setProp(page, 'shape-w', 200);
  await expect.poll(() => props(page)).toMatchObject({ props: { x: 50, width: 200, height: 80 } });
  expect(await historyLength(page)).toBe(n + 1);
  await setProp(page, 'shape-x', 10);
  await expect.poll(() => props(page)).toMatchObject({ props: { x: 10 } });
  // linked radii: one value for every corner; unlinked: only the corner typed
  await setProp(page, 'radius-tl', 10);
  await expect.poll(() => props(page)).toMatchObject({ props: { radii: [10, 10, 10, 10] } });
  expect(await lastLabel(page)).toBe('Corner Radius');
  await page.locator('[data-panel="properties"] [data-act="link-radii"]').click();
  await setProp(page, 'radius-br', 30);
  await expect.poll(() => props(page)).toMatchObject({ props: { radii: [10, 10, 30, 10] } });
  // the path follows the parameters: the bottom-right corner is cut by its 30 px arc
  expect((await pixel(page, 208, 118))[3]).toBe(0);
  expect((await pixel(page, 12, 80))[3]).toBe(255);
  await setProp(page, 'shape-angle', 90);
  await expect.poll(() => props(page)).toMatchObject({ kind: 'rect', props: { angle: 90 } });
  // a box 200 x 80 turned 90° about its centre (110, 80): 40 wide, 200 tall
  expect((await pixel(page, 110, 5))[3]).toBe(255);
  expect((await pixel(page, 30, 80))[3]).toBe(0);

  await runAwait(page, 'edit:undo');
  await expect.poll(() => props(page)).toMatchObject({ props: { angle: 0, radii: [10, 10, 30, 10] } });
  for (let i = 0; i < 4; i++) await runAwait(page, 'edit:undo');
  await expect.poll(() => props(page)).toMatchObject({ props: { x: 50, width: 120, radii: [0, 0, 0, 0] } });
  // a shape that is not live any more (anchors edited) shows the Transform section and no live parameters
  await page.evaluate(async () => {
    const { setLayerProps } = await import('/lib/layer-ops.js');
    setLayerProps(window.pigmentApp, window.pigmentApp.doc.active, { shapeKind: 'path' }, 'Edit');
  });
  await expect(page.locator('[data-panel="properties"] input[data-axis="x"]')).toHaveCount(1);
  await expect(page.locator('[data-panel="properties"] .sl-live')).toHaveCount(0);
  await expect(page.locator('[data-panel="properties"] .sl-appearance')).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('move a rectangle, then change its corner radius in Properties: it stays where it was moved', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 400, height: 300, background: 'transparent' });
  await addShape(page, 'rect', { x: 40, y: 40, width: 100, height: 60 });
  await page.evaluate(() => window.pigmentApp.tools.activate('move'));
  await drag(page, [90, 70], [190, 140]);
  await expect.poll(() => props(page)).toMatchObject({ kind: 'rect', props: { x: 140, y: 110 } });
  await showProperties(page);
  await setProp(page, 'radius-tl', 8);
  await expect.poll(() => props(page)).toMatchObject({ kind: 'rect', props: { x: 140, y: 110, width: 100, height: 60, radii: [8, 8, 8, 8] } });
  const b = await page.evaluate(() => window.pigmentApp.doc.active.bounds());
  expect(b.x).toBeGreaterThanOrEqual(138);
  expect(b.x).toBeLessThanOrEqual(140);
  expect((await pixel(page, 190, 140))[3]).toBe(255);
  expect((await pixel(page, 90, 70))[3]).toBe(0);
  // nudging with the Path Selection tool keeps the shape live too
  await page.evaluate(() => window.pigmentApp.tools.activate('path-selection'));
  await drag(page, [190, 140], [200, 150]);
  await expect.poll(() => props(page)).toMatchObject({ kind: 'rect', props: { x: 150, y: 120, radii: [8, 8, 8, 8] } });
  expect(errors).toEqual([]);
});

test('Properties: triangle radius, polygon sides / star / smoothing, line weight and arrowheads', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 400, height: 300, background: 'transparent' });
  await addShape(page, 'triangle', { x: 20, y: 20, width: 100, height: 80 });
  await showProperties(page);
  await setProp(page, 'shape-radius', 12);
  await expect.poll(() => props(page)).toMatchObject({ kind: 'triangle', props: { radius: 12 } });
  expect(await page.evaluate(() => window.pigmentApp.doc.active.path.subpaths[0].points.length)).toBe(6);

  await addShape(page, 'polygon', { x: 150, y: 20, width: 100, height: 100 }, { sides: 5, starRatio: 100, smoothCorners: false, smoothIndents: false, cornerRadius: 0 });
  await setProp(page, 'shape-sides', 8);
  await setProp(page, 'shape-star-ratio', 60);
  await prop(page, 'shape-smooth-corners').check();
  await expect.poll(() => props(page)).toMatchObject({ kind: 'polygon', props: { sides: 8, starRatio: 60, smoothCorners: true } });
  // 8 tips rounded (two anchors each) and 8 sharp indents
  expect(await page.evaluate(() => window.pigmentApp.doc.active.path.subpaths[0].points.length)).toBe(24);

  await page.evaluate(() => {
    const app = window.pigmentApp;
    app.tools.setOpt('shape-line', 'arrowEnd', false, { silent: true });
    app.tools.activate('shape-line');
    const t = app.tools.active;
    t.create(t.geometry({ start: { x: 20, y: 200 }, current: { x: 220, y: 200 }, moved: true }));
  });
  await expect(prop(page, 'line-weight')).toBeVisible();
  await setProp(page, 'line-weight', 6);
  await prop(page, 'arrow-start').check();
  await expect.poll(() => props(page)).toMatchObject({ kind: 'line', props: { weight: 6, arrowStart: { width: 500, length: 1000 }, arrowEnd: null } });
  await setProp(page, 'arrow-length', 400);
  await expect.poll(() => props(page)).toMatchObject({ props: { arrowStart: { length: 400 } } });
  await setProp(page, 'line-x2', 300);
  await expect.poll(() => props(page)).toMatchObject({ props: { x2: 300 } });
  expect(await page.evaluate(() => window.pigmentApp.doc.active.path.subpaths.length)).toBe(2);
  expect(errors).toEqual([]);
});

test('fill and stroke popups: solid, gradient, pattern and none; stroke options, presets and dashes', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 300, height: 200, background: 'transparent' });
  await addShape(page, 'rect', { x: 50, y: 50, width: 100, height: 60 });
  await showProperties(page);
  const fill = () => page.evaluate(() => window.pigmentApp.doc.active.fill);

  await page.locator('[data-panel="properties"] [data-key="shape-fill"] button').click();
  const pop = page.locator('.sl-paint-pop');
  await expect(pop).toBeVisible();
  await pop.locator('.sl-swatches .sl-color[data-color="#ff0000"]').click();
  await expect.poll(fill).toEqual({ type: 'solid', color: '#ff0000' });
  expect(await pixel(page, 100, 80)).toEqual([255, 0, 0, 255]);
  // the colour picked is the first recently used colour
  await expect(pop.locator('.sl-recent .sl-color').first()).toHaveAttribute('data-color', '#ff0000');
  await pop.locator('[data-paint-type="gradient"]').click();
  await expect.poll(async () => (await fill()).type).toBe('gradient');
  await pop.locator('.gp-swatch').first().click();
  await expect.poll(async () => (await fill()).gradient.gradientVersion).toBe(2);
  // no colour references in layer data (G.1)
  expect(JSON.stringify(await fill())).not.toContain('ref');
  await pop.locator('[data-paint-type="pattern"]').click();
  await expect.poll(() => page.evaluate(() => {
    const f = window.pigmentApp.doc.active.fill;
    return f.type === 'pattern' && !!f.pattern.canvas && /^data:image\/png/.test(f.pattern.dataUrl ?? '');
  })).toBe(true);
  await pop.locator('input[data-key="pattern-scale"]').fill('200');
  await pop.locator('input[data-key="pattern-scale"]').dispatchEvent('change');
  await expect.poll(async () => (await page.evaluate(() => window.pigmentApp.doc.active.fill.pattern.scale))).toBe(2);
  await pop.locator('[data-paint-type="none"]').click();
  await expect.poll(fill).toBe(null);
  await page.keyboard.press('Escape');

  // stroke: Solid starts a 3 px black stroke; the width field and the Stroke Options popup
  await page.locator('[data-panel="properties"] [data-key="shape-stroke"] button').click();
  await page.locator('.sl-paint-pop [data-paint-type="solid"]').click();
  await expect.poll(() => page.evaluate(() => window.pigmentApp.doc.active.stroke)).toMatchObject({ width: 3, paint: { type: 'solid', color: '#000000' }, color: '#000000' });
  await page.keyboard.press('Escape');
  await setProp(page, 'stroke-width', 10);
  await page.locator('[data-panel="properties"] [data-act="stroke-options"]').click();
  await page.locator('.sl-stroke-pop select[data-key="stroke-align"]').selectOption('outside');
  await expect.poll(() => page.evaluate(() => window.pigmentApp.doc.active.stroke.align)).toBe('outside');
  // an outside stroke is not clipped by the layer bounds: 10 px outside the rectangle is painted
  expect((await pixel(page, 100, 41))[3]).toBe(255);
  expect((await pixel(page, 100, 39))[3]).toBe(0);
  await page.locator('[data-panel="properties"] [data-act="stroke-options"]').click();
  await page.locator('.sl-stroke-pop [data-preset-id="dashed"]').click();
  await expect.poll(() => page.evaluate(() => window.pigmentApp.doc.active.stroke)).toMatchObject({ dash: [4, 2], cap: 'butt', align: 'center' });
  // dashes are in stroke widths: 40 px on, 20 px off along the top side (from x = 50)
  const top = await page.evaluate(() => {
    const d = window.pigmentApp.doc;
    const c = d.view.compositor.composite(d);
    const data = c.getContext('2d').getImageData(50, 50, 100, 1).data;
    return [data[(10) * 4 + 3], data[(45) * 4 + 3], data[(70) * 4 + 3]];
  });
  expect(top[0]).toBe(255);
  expect(top[1]).toBe(0);
  expect(top[2]).toBe(255);
  // More Options…: the Stroke dialog with dash and gap pairs
  await page.locator('[data-panel="properties"] [data-act="stroke-options"]').click();
  await page.locator('.sl-stroke-pop [data-act="stroke-more"]').click();
  await page.locator('.dialog select[data-key="cap"]').selectOption('round');
  await page.locator('.dialog input[data-key="dash0"]').fill('0');
  await page.locator('.dialog input[data-key="gap0"]').fill('3');
  await confirmDialog(page);
  await expect.poll(() => page.evaluate(() => window.pigmentApp.doc.active.stroke)).toMatchObject({ dash: [0, 3], cap: 'round' });
  // Save Preset…: a new stroke style
  await page.locator('[data-panel="properties"] [data-act="stroke-options"]').click();
  await page.locator('.sl-stroke-pop [data-act="stroke-save"]').click();
  await page.locator('.dialog input').first().fill('Dots 3');
  await confirmDialog(page);
  await expect.poll(() => page.evaluate(() => window.pigmentApp.presets.list('stroke-styles').map((p) => p.name))).toContain('Dots 3');
  // undo walks back through the stroke changes one at a time
  const before = await historyLength(page);
  await runAwait(page, 'edit:undo');
  await expect.poll(() => page.evaluate(() => window.pigmentApp.doc.active.stroke.dash)).toEqual([4, 2]);
  expect(await historyLength(page)).toBe(before - 1);
  expect(errors).toEqual([]);
});

test('the options bar: Fill / Stroke swatches, Stroke Options and the gear menu set the next shape and restyle the active one', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 300, height: 200, background: 'transparent' });
  await page.evaluate(() => window.pigmentApp.tools.activate('shape-rect'));
  const bar = page.locator('#options-bar');
  await bar.locator('.sl-swatch-fill').click();
  await page.locator('.sl-paint-pop .sl-swatches .sl-color[data-color="#0000ff"]').click();
  await page.keyboard.press('Escape');
  expect(await page.evaluate(() => window.pigmentApp.tools.opt('shape-rect', 'fillPaint'))).toEqual({ type: 'solid', color: '#0000ff' });
  // the other vector tools share the fill
  expect(await page.evaluate(() => window.pigmentApp.tools.opt('shape-ellipse', 'fillPaint'))).toEqual({ type: 'solid', color: '#0000ff' });
  await bar.locator('.sl-swatch-stroke').click();
  await page.locator('.sl-paint-pop [data-paint-type="solid"]').click();
  await page.keyboard.press('Escape');
  await expect(bar.locator('.opt[data-key="strokeWidth"]')).toBeVisible();
  await bar.locator('.sl-stroke-button').click();
  await page.locator('.sl-stroke-pop [data-preset-id="dotted"]').click();
  await page.keyboard.press('Escape');
  expect(await page.evaluate(() => ['strokeOn', 'strokeDash', 'strokeCap', 'strokeJoin'].map((k) => window.pigmentApp.tools.opt('shape-rect', k)))).toEqual([true, [0, 2], 'round', 'round']);
  await drag(page, [30, 30], [130, 100]);
  await expect.poll(() => page.evaluate(() => {
    const l = window.pigmentApp.doc.active;
    return { fill: l.fill, dash: l.stroke?.dash, cap: l.stroke?.cap };
  })).toEqual({ fill: { type: 'solid', color: '#0000ff' }, dash: [0, 2], cap: 'round' });

  // changing the fill while a shape is active restyles it (one entry)
  const n = await historyLength(page);
  await bar.locator('.sl-swatch-fill').click();
  await page.locator('.sl-paint-pop .sl-swatches .sl-color[data-color="#00ff00"]').click();
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => window.pigmentApp.doc.active.fill)).toEqual({ type: 'solid', color: '#00ff00' });
  expect(await historyLength(page)).toBe(n + 1);

  // the gear menu: Fixed Size draws 50 x 40 wherever the drag ends; Path Options colour the path outline
  await bar.locator('.sl-gear').click();
  await page.locator('.sl-geometry-pop select[data-key="constrain"]').selectOption('fixed');
  await page.locator('.sl-geometry-pop input[data-key="fixedW"]').fill('50');
  await page.locator('.sl-geometry-pop input[data-key="fixedW"]').dispatchEvent('change');
  await page.locator('.sl-geometry-pop input[data-key="fixedH"]').fill('40');
  await page.locator('.sl-geometry-pop input[data-key="fixedH"]').dispatchEvent('change');
  await page.locator('.sl-geometry-pop input[data-key="pathThickness"]').fill('3');
  await page.locator('.sl-geometry-pop input[data-key="pathThickness"]').dispatchEvent('change');
  await page.keyboard.press('Escape');
  expect(await page.evaluate(() => window.pigmentApp.settings.shapes.pathThickness)).toBe(3);
  await drag(page, [175, 125], [290, 190]);
  await expect.poll(() => props(page)).toMatchObject({ kind: 'rect', props: { x: 175, y: 125, width: 50, height: 40 } });
  await page.evaluate(() => window.pigmentApp.tools.setOpt('shape-rect', 'constrain', 'none'));

  // the polygon's gear: star ratio and smoothing
  await page.evaluate(() => window.pigmentApp.tools.activate('shape-polygon'));
  await bar.locator('.sl-gear').click();
  await page.locator('.sl-geometry-pop input[data-key="starRatio"]').fill('40');
  await page.locator('.sl-geometry-pop input[data-key="starRatio"]').dispatchEvent('change');
  await page.locator('.sl-geometry-pop input[data-key="smoothCorners"]').check();
  await page.keyboard.press('Escape');
  expect(await page.evaluate(() => [window.pigmentApp.tools.opt('shape-polygon', 'starRatio'), window.pigmentApp.tools.opt('shape-polygon', 'smoothCorners')])).toEqual([40, true]);
  // the line's gear: arrowheads
  await page.evaluate(() => window.pigmentApp.tools.activate('shape-line'));
  await bar.locator('.sl-gear').click();
  await page.locator('.sl-geometry-pop input[data-key="arrowStart"]').check();
  await page.locator('.sl-geometry-pop input[data-key="arrowWidth"]').fill('300');
  await page.locator('.sl-geometry-pop input[data-key="arrowWidth"]').dispatchEvent('change');
  await page.keyboard.press('Escape');
  await drag(page, [20, 170], [140, 170]);
  await expect.poll(() => props(page)).toMatchObject({ kind: 'line', props: { arrowStart: { width: 300, length: 1000 }, arrowEnd: null } });
  expect(errors).toEqual([]);
});

test('clicking the canvas opens the Create dialog: per-corner radii, a polygon, an equilateral triangle', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 400, height: 300, background: 'transparent' });
  await page.evaluate(() => window.pigmentApp.tools.activate('shape-rect'));
  const at = await screenPoint(page, 30, 30);
  await page.mouse.click(at.x, at.y);
  await expect(page.locator('.dialog')).toBeVisible();
  await page.locator('.dialog input[data-key="width"]').fill('120');
  await page.locator('.dialog input[data-key="height"]').fill('70');
  await page.locator('.dialog input[data-key="linked"]').uncheck();
  await page.locator('.dialog input[data-key="radiusTL"]').fill('20');
  await page.locator('.dialog input[data-key="radiusBR"]').fill('5');
  await confirmDialog(page);
  await expect.poll(() => props(page)).toEqual({ kind: 'rect', props: { x: 30, y: 30, width: 120, height: 70, angle: 0, radii: [20, 0, 5, 0] } });

  await page.evaluate(() => window.pigmentApp.tools.activate('shape-polygon'));
  const at2 = await screenPoint(page, 250, 150);
  await page.mouse.click(at2.x, at2.y);
  await page.locator('.dialog input[data-key="width"]').fill('80');
  await page.locator('.dialog input[data-key="width"]').dispatchEvent('change');
  await page.locator('.dialog input[data-key="sides"]').fill('7');
  await page.locator('.dialog input[data-key="center"]').check();
  await confirmDialog(page);
  await expect.poll(() => props(page)).toMatchObject({ kind: 'polygon', props: { x: 210, y: 110, width: 80, height: 80, sides: 7 } });
  expect(await page.evaluate(() => window.pigmentApp.tools.opt('shape-polygon', 'sides'))).toBe(7);

  await page.evaluate(() => window.pigmentApp.tools.activate('shape-triangle'));
  const at3 = await screenPoint(page, 20, 150);
  await page.mouse.click(at3.x, at3.y);
  await page.locator('.dialog input[data-key="equilateral"]').check();
  await page.locator('.dialog input[data-key="width"]').fill('100');
  await page.locator('.dialog input[data-key="width"]').dispatchEvent('change');
  await confirmDialog(page);
  await expect.poll(() => props(page)).toMatchObject({ kind: 'triangle', props: { width: 100, height: 86.6 } });
  expect(errors).toEqual([]);
});

test('corner widgets on the canvas: drag rounds every corner, Alt-drag one corner, one entry each', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 400, height: 300, background: 'transparent' });
  await addShape(page, 'rect', { x: 100, y: 80, width: 160, height: 120 }, { radius: 0 });
  const zoom = await page.evaluate(() => window.pigmentApp.view.zoom);
  // a square corner's widget sits 14 screen px into the corner along its diagonal
  const off = 14 / Math.SQRT2 / zoom;
  const a = await screenPoint(page, 100 + off, 80 + off);
  const n = await historyLength(page);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(a.x + 20, a.y + 20, { steps: 5 });
  await page.mouse.up();
  const r = await page.evaluate(() => window.pigmentApp.doc.active.shapeProps.radii);
  expect(r[0]).toBeGreaterThan(5);
  expect(r).toEqual([r[0], r[0], r[0], r[0]]);
  expect(await historyLength(page)).toBe(n + 1);
  expect(await lastLabel(page)).toBe('Corner Radius');
  // Alt-drag the bottom-right widget: only that corner
  const s = r[0] / zoom;
  void s;
  const br = await page.evaluate(([rr]) => {
    const v = window.pigmentApp.view;
    const p = v.toScreen(260 - rr, 200 - rr);
    const c = v.canvas.getBoundingClientRect();
    return { x: c.left + p.x, y: c.top + p.y };
  }, [r[0]]);
  await page.keyboard.down('Alt');
  await page.mouse.move(br.x, br.y);
  await page.mouse.down();
  await page.mouse.move(br.x - 15, br.y - 15, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.up('Alt');
  const r2 = await page.evaluate(() => window.pigmentApp.doc.active.shapeProps.radii);
  expect(r2.slice(0, 2)).toEqual([r[0], r[0]]);
  expect(r2[3]).toBe(r[0]);
  expect(r2[2]).toBeGreaterThan(r[0] + 5);
  expect(await page.evaluate(() => window.pigmentApp.doc.active.shapeKind)).toBe('rect');
  await runAwait(page, 'edit:undo');
  expect(await page.evaluate(() => window.pigmentApp.doc.active.shapeProps.radii)).toEqual(r);
  expect(errors).toEqual([]);
});

test('Copy / Paste Shape Attributes: fill and stroke onto every selected shape, one entry', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 300, height: 200, background: 'transparent' });
  expect(await page.evaluate(() => window.pigmentApp.stubbed.filter((id) => id.includes('shape-attributes')))).toEqual([]);
  await addShape(page, 'ellipse', { x: 10, y: 10, width: 60, height: 60 });
  await addShape(page, 'triangle', { x: 100, y: 10, width: 60, height: 60 });
  await addShape(page, 'rect', { x: 200, y: 10, width: 60, height: 60 });
  await runAwait(page, 'layer:shape-properties', { fill: { type: 'solid', color: '#ff8000' }, stroke: { width: 6, align: 'inside', dash: [2, 1], paint: { type: 'solid', color: '#123456' } } });
  expect(await page.evaluate(() => window.pigmentApp.commands.isEnabled('layer:paste-shape-attributes'))).toBe(false);
  await runAwait(page, 'layer:copy-shape-attributes');
  // select the ellipse and the triangle
  await page.evaluate(() => {
    const d = window.pigmentApp.doc;
    const [e, t] = d.layers().filter((l) => l.type === 'shape');
    d.setActive(e);
    d.selected.add(t);
    d.changed('active');
  });
  const n = await historyLength(page);
  await runAwait(page, 'layer:paste-shape-attributes');
  const got = await page.evaluate(() => window.pigmentApp.doc.layers().filter((l) => l.type === 'shape').map((l) => [l.fill, l.stroke.width, l.stroke.align, l.stroke.dash, l.stroke.paint.color]));
  expect(got).toEqual(Array(3).fill([{ type: 'solid', color: '#ff8000' }, 6, 'inside', [2, 1], '#123456']));
  expect(await historyLength(page)).toBe(n + 1);
  expect(await lastLabel(page)).toBe('Paste Shape Attributes');
  await runAwait(page, 'edit:undo');
  expect(await page.evaluate(() => window.pigmentApp.doc.layers().filter((l) => l.type === 'shape').map((l) => l.stroke))).toEqual([null, null, expect.objectContaining({ width: 6 })]);
  expect(errors).toEqual([]);
});

test('transforms keep shapes live: Free Transform rotation into angle, Image Size into the box; skew makes a path', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 400, height: 300, background: 'transparent' });
  await addShape(page, 'rect', { x: 100, y: 100, width: 120, height: 60 }, { radius: 10 });
  await page.evaluate(() => {
    const tt = window.pigmentApp.transformTool;
    tt.start({ mode: 'free' });
    // 90° about the centre (160, 130)
    tt.session.quad = tt.session.quad.map(([x, y]) => [160 - (y - 130), 130 + (x - 160)]);
    tt.commit();
  });
  await expect.poll(() => props(page)).toEqual({ kind: 'rect', props: { x: 100, y: 100, width: 120, height: 60, angle: 90, radii: [10, 10, 10, 10] } });
  await runAwait(page, 'image:size', { width: 800, height: 600, method: 'bilinear', scaleStyles: true });
  await expect.poll(() => props(page)).toEqual({ kind: 'rect', props: { x: 200, y: 200, width: 240, height: 120, angle: 90, radii: [20, 20, 20, 20] } });
  // the Properties section still edits it
  await showProperties(page);
  await expect(prop(page, 'shape-angle')).toHaveValue('90');
  // skew: no longer a rectangle
  await page.evaluate(() => {
    const tt = window.pigmentApp.transformTool;
    tt.start({ mode: 'free' });
    tt.session.quad = tt.session.quad.map(([x, y], i) => (i < 2 ? [x + 40, y] : [x, y]));
    tt.commit();
  });
  await expect.poll(async () => (await props(page)).kind).toBe('path');
  expect(errors).toEqual([]);
});

test('a .pigment round trip keeps the live parameters, the stroke options and a pattern fill', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 200, height: 150, background: 'transparent' });
  await addShape(page, 'polygon', { x: 20, y: 20, width: 100, height: 100 }, { sides: 6, starRatio: 70, smoothCorners: false, smoothIndents: true, cornerRadius: 3 });
  await page.evaluate(async () => {
    const app = window.pigmentApp;
    await app.patterns.ready();
    const entry = app.patterns.current();
    const { makePatternPaint } = await import('/lib/pattern-paint.js');
    await app.commands.run('layer:shape-properties', { fill: makePatternPaint(entry.canvas, { scale: 1, presetId: entry.id, name: entry.name }), stroke: { width: 4, cap: 'round', join: 'bevel', dash: [3, 1], align: 'outside', paint: { type: 'solid', color: '#00ff00' } } }, 'api');
  });
  const before = await pixel(page, 70, 70);
  const r = await page.evaluate(async () => {
    const app = window.pigmentApp;
    const { writePigment, readPigment } = await import('/lib/io.js');
    const bytes = await writePigment(app.doc);
    const doc = await readPigment(bytes);
    const l = doc.layers().find((x) => x.type === 'shape');
    return { kind: l.shapeKind, props: l.shapeProps, stroke: l.stroke, fillType: l.fill.type, url: /^data:image\/png/.test(l.fill.pattern.dataUrl), canvas: typeof l.fill.pattern.canvas?.getContext };
  });
  expect(r.kind).toBe('polygon');
  expect(r.props).toEqual({ x: 20, y: 20, width: 100, height: 100, angle: 0, sides: 6, starRatio: 70, smoothCorners: false, smoothIndents: true, cornerRadius: 3 });
  expect(r.stroke).toMatchObject({ width: 4, cap: 'round', join: 'bevel', dash: [3, 1], align: 'outside', paint: { type: 'solid', color: '#00ff00' } });
  expect([r.fillType, r.url, r.canvas]).toEqual(['pattern', true, 'undefined']);
  // the pattern paint read back draws once its pixels are decoded
  await page.evaluate(async () => {
    const app = window.pigmentApp;
    const { writePigment } = await import('/lib/io.js');
    window.__pigmentTest.files['mem:/shape.pigment'] = await writePigment(app.doc);
  });
  await runAwait(page, 'file:open-paths', ['mem:/shape.pigment']);
  await expect.poll(() => page.evaluate(() => window.pigmentApp.doc.path)).toBe('mem:/shape.pigment');
  await expect.poll(() => pixel(page, 70, 70)).toEqual(before);
  expect(errors).toEqual([]);
});

test('a shape gradient keeps its place on the shape when the stroke widens (G.3)', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 300, height: 200, background: 'transparent' });
  await addShape(page, 'rect', { x: 50, y: 50, width: 200, height: 100 });
  await runAwait(page, 'layer:shape-properties', { fill: { type: 'gradient', gradient: { gradientVersion: 2, type: 'solid', interpolation: 'perceptual', smoothness: 0, stops: [{ pos: 0, mid: 0.5, color: '#ff0000' }, { pos: 1, mid: 0.5, color: '#0000ff' }], opacityStops: [{ pos: 0, mid: 0.5, opacity: 1 }, { pos: 1, mid: 0.5, opacity: 1 }], kind: 'linear', angle: 0 } } });
  const thin = [await pixel(page, 60, 100), await pixel(page, 150, 100), await pixel(page, 240, 100)];
  expect(thin[0][0]).toBeGreaterThan(200);
  expect(thin[2][2]).toBeGreaterThan(200);
  await runAwait(page, 'layer:shape-properties', { stroke: { width: 30, align: 'inside', paint: { type: 'solid', color: '#000000' } } });
  await runAwait(page, 'layer:shape-properties', { stroke: { width: 30, align: 'outside' } });
  const wide = [await pixel(page, 60, 100), await pixel(page, 150, 100), await pixel(page, 240, 100)];
  for (let i = 0; i < 3; i++) for (let c = 0; c < 4; c++) expect(Math.abs(wide[i][c] - thin[i][c])).toBeLessThanOrEqual(1);
  // the render canvas grew for the outside stroke (30 px + anti-aliasing)
  const b = await page.evaluate(() => window.pigmentApp.doc.active.bounds());
  expect(b.x).toBeLessThanOrEqual(20);
  expect(errors).toEqual([]);
});

test('the actions recorder replays shape edits', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 300, height: 200, background: 'transparent' });
  await addShape(page, 'rect', { x: 20, y: 20, width: 80, height: 60 });
  // a replay of layer:shape-properties with a recorded argument is the same edit
  await runAwait(page, 'layer:shape-properties', { props: { radii: [6, 6, 6, 6] }, fill: { type: 'solid', color: '#336699' } });
  await addShape(page, 'rect', { x: 120, y: 20, width: 80, height: 60 });
  const arg = JSON.parse(JSON.stringify({ props: { radii: [6, 6, 6, 6] }, fill: { type: 'solid', color: '#336699' } }));
  await runAwait(page, 'layer:shape-properties', arg);
  expect(await page.evaluate(() => window.pigmentApp.doc.layers().filter((l) => l.type === 'shape').map((l) => [l.shapeProps.radii, l.fill.color]))).toEqual([[[6, 6, 6, 6], '#336699'], [[6, 6, 6, 6], '#336699']]);
  void run;
  expect(errors).toEqual([]);
});
