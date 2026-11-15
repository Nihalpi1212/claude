// layer-style-effects (Pigment 0.4, ARCHITECTURE.md "0.4 features", package 6): effect instances in the Layer Style
// dialog, contours and the Contour Editor, the Bevel & Emboss Texture, dragging in the document to place a shadow,
// and a .pigment round trip of instances and contours.
import { test, expect } from '@playwright/test';
import { openApp, newDoc, run, runAwait, pixel, historyLength, confirmDialog } from './helpers.mjs';

/** A transparent 200 x 160 document with a blue 80 x 60 rectangle at (60, 40). */
async function blueRect(page) {
  await newDoc(page, { width: 200, height: 160, background: 'transparent' });
  await page.evaluate(() => {
    const l = window.pigmentApp.doc.active;
    const ctx = l.canvas.getContext('2d');
    ctx.fillStyle = '#0000ff';
    ctx.fillRect(60, 40, 80, 60);
    l.touch();
  });
}

const dialog = (page) => page.locator('.style-dialog');
const pane = (page) => page.locator('.style-dialog .style-pane');
const styles = (page) => page.evaluate(() => JSON.parse(JSON.stringify(window.pigmentApp.doc.active.styles)));

async function setNumber(page, key, value) {
  const input = pane(page).locator(`input[type="number"][data-key="${key}"]`);
  await input.fill(String(value));
  await input.dispatchEvent('change');
}

test('two drop shadows: + adds an instance, both render, one undo step, the list reorders and deletes', async ({ page }) => {
  const errors = await openApp(page);
  await blueRect(page);
  const n = await historyLength(page);
  await run(page, 'layer:style', 'dropShadow');
  await expect(dialog(page)).toBeVisible();
  await page.locator('.style-list [data-style="dropShadow"] input').check();
  // a hard black shadow 12 px down
  await setNumber(page, 'size', 0);
  await setNumber(page, 'distance', 12);
  await setNumber(page, 'angle', 90);
  await setNumber(page, 'opacity', 100);
  await pane(page).locator('select[data-key="blend"]').selectOption('normal');
  // + duplicates it above; the copy is selected: 12 px to the left instead
  await page.locator('.style-list [data-add="dropShadow"]').click();
  await expect(page.locator('.style-list [data-style="dropShadow"]')).toHaveCount(2);
  await expect(pane(page).locator('h3')).toHaveText('Drop Shadow (1 of 2)');
  await setNumber(page, 'angle', 0);
  const live = await styles(page);
  expect(live.dropShadow.map((s) => s.angle)).toEqual([0, 90]);
  // reorder: the selected (top) instance moves down, then back up
  await page.locator('.style-list-tools [data-act="down"]').click();
  expect((await styles(page)).dropShadow.map((s) => s.angle)).toEqual([90, 0]);
  await page.locator('.style-list-tools [data-act="up"]').click();
  expect((await styles(page)).dropShadow.map((s) => s.angle)).toEqual([0, 90]);
  await confirmDialog(page);
  const st = await styles(page);
  expect(st.dropShadow).toHaveLength(2);
  // both shadows show: below the rectangle and left of it
  expect(await pixel(page, 100, 105)).toEqual([0, 0, 0, 255]);
  expect(await pixel(page, 52, 70)).toEqual([0, 0, 0, 255]);
  expect(await pixel(page, 100, 120)).toEqual([0, 0, 0, 0]);
  expect(await historyLength(page)).toBe(n + 1);
  await runAwait(page, 'edit:undo');
  expect(await page.evaluate(() => window.pigmentApp.doc.active.styles)).toBeNull();
  await runAwait(page, 'edit:redo');
  // delete one instance in the dialog: one shadow is left, written as an object
  await run(page, 'layer:style', 'dropShadow');
  await expect(dialog(page)).toBeVisible();
  await page.locator('.style-list [data-style="dropShadow"][data-index="0"] .style-name').click();
  await page.locator('.style-list-tools [data-act="delete"]').click();
  await expect(page.locator('.style-list [data-style="dropShadow"]')).toHaveCount(1);
  await confirmDialog(page);
  const one = await styles(page);
  expect(Array.isArray(one.dropShadow)).toBe(false);
  expect(one.dropShadow.angle).toBe(90);
  expect(await pixel(page, 52, 70)).toEqual([0, 0, 0, 0]);
  expect(errors).toEqual([]);
});

test('a contour preset and the Contour Editor reshape the shadow; Cancel puts it back', async ({ page }) => {
  const errors = await openApp(page);
  await blueRect(page);
  await runAwait(page, 'layer:style', { styles: { dropShadow: { enabled: true, size: 16, distance: 0, opacity: 1, blend: 'normal', color: '#000000' } } });
  const before = await pixel(page, 148, 70);
  expect(before[3]).toBeGreaterThan(20);
  await run(page, 'layer:style', 'dropShadow');
  await expect(dialog(page)).toBeVisible();
  const widget = pane(page).locator('[data-widget="contour"]');
  await expect(widget).toHaveCount(1);
  await widget.locator('.cw-more').click();
  // Photoshop's built-in contours are listed
  await expect(widget.locator('.cw-item')).toHaveCount(12);
  await widget.locator('.cw-item[data-preset-id="cone-inverted"]').click();
  expect((await styles(page)).dropShadow.contour.name).toBe('Cone - Inverted');
  await expect(widget.locator('.cw-name')).toHaveText('Cone - Inverted');
  const coned = await pixel(page, 148, 70);
  expect(coned).not.toEqual(before);
  // the Contour Editor: a click on the curve adds a point; OK writes it
  await widget.locator('.cw-preview').click();
  const editor = page.locator('.contour-editor-dialog');
  await expect(editor).toBeVisible();
  const canvas = editor.locator('canvas.ce-canvas');
  const box = await canvas.boundingBox();
  await page.mouse.click(box.x + box.width * 0.25, box.y + box.height * 0.3);
  await expect.poll(async () => JSON.parse(await canvas.getAttribute('data-points')).length).toBe(4);
  await editor.locator('input[data-key="corner"]').check();
  await editor.locator('.dialog-buttons .btn.primary').click();
  await expect(editor).toHaveCount(0);
  const pts = (await styles(page)).dropShadow.contour.points;
  expect(pts).toHaveLength(4);
  expect(pts.filter((p) => p.corner)).toHaveLength(2);
  await expect(widget.locator('.cw-name')).toHaveText('Custom');
  // Cancel the Layer Style dialog: the shadow is back to Linear
  await page.locator('.style-dialog .dialog-buttons [data-value="null"]').click();
  await expect(dialog(page)).toHaveCount(0);
  expect((await styles(page)).dropShadow.contour ?? null).toBeNull();
  expect(await pixel(page, 148, 70)).toEqual(before);
  // Save as Preset adds a contour preset
  const saved = await page.evaluate(async () => {
    const app = window.pigmentApp;
    const { openContourEditor } = await import('/lib/contour-editor.js');
    const done = openContourEditor(app, { value: { points: [{ x: 0, y: 0 }, { x: 0.5, y: 0.8 }, { x: 1, y: 0.2 }] } });
    await new Promise((r) => requestAnimationFrame(r));
    document.querySelector('.contour-editor-dialog [data-act="save-preset"]').click();
    await new Promise((r) => setTimeout(r, 50));
    const input = [...document.querySelectorAll('.dialog input.input')].pop();
    input.value = 'Hill';
    [...document.querySelectorAll('.dialog-buttons .btn.primary')].pop().click();
    await new Promise((r) => setTimeout(r, 100));
    [...document.querySelectorAll('.contour-editor-dialog .dialog-buttons .btn.primary')].pop().click();
    const res = await done;
    return { name: res.name, listed: app.presets.list('contours').some((p) => p.name === 'Hill') };
  });
  expect(saved).toEqual({ name: 'Hill', listed: true });
  expect(errors).toEqual([]);
});

test('Bevel & Emboss Texture: the current pattern bumps the flat inside of the layer', async ({ page }) => {
  const errors = await openApp(page);
  await page.evaluate(() => window.pigmentApp.patterns.ready());
  await newDoc(page, { width: 200, height: 160, background: 'transparent' });
  await page.evaluate(() => {
    const l = window.pigmentApp.doc.active;
    const ctx = l.canvas.getContext('2d');
    ctx.fillStyle = '#808080';
    ctx.fillRect(20, 20, 160, 120);
    l.touch();
  });
  await runAwait(page, 'layer:style', { styles: { bevel: { enabled: true, size: 5 } } });
  const row = async () => page.evaluate(() => {
    const d = window.pigmentApp.doc;
    const c = d.view.compositor.composite(d);
    const data = c.getContext('2d').getImageData(60, 80, 80, 1).data;
    const v = [];
    for (let i = 0; i < data.length; i += 4) v.push(data[i]);
    return v;
  });
  const flat = await row();
  expect(new Set(flat).size).toBe(1);
  await run(page, 'layer:style', 'bevel');
  await expect(dialog(page)).toBeVisible();
  await page.locator('.style-list [data-style="bevel-texture"] input').check();
  await page.locator('.style-list [data-style="bevel-texture"] .style-name').click();
  await expect(pane(page).locator('[data-widget="pattern"]')).toHaveCount(1);
  await setNumber(page, '__tx_depth', 300);
  await confirmDialog(page);
  const st = await styles(page);
  expect(st.bevel.texture.enabled).toBe(true);
  expect(typeof st.bevel.texture.pattern.dataUrl).toBe('string');
  expect(st.bevel.texture.depth).toBe(3);
  await expect.poll(async () => new Set(await row()).size).toBeGreaterThan(2);
  expect(errors).toEqual([]);
});

test('dragging in the document places the drop shadow while the dialog is open', async ({ page }) => {
  const errors = await openApp(page);
  await blueRect(page);
  await runAwait(page, 'layer:style', { styles: { dropShadow: { enabled: true, size: 0, distance: 0, angle: 120, opacity: 1, blend: 'normal', color: '#000000' } } });
  await run(page, 'layer:style', 'dropShadow');
  await expect(dialog(page)).toBeVisible();
  // a point of the canvas the dialog does not cover
  const pts = await page.evaluate(() => {
    const v = window.pigmentApp.view;
    const r = v.canvas.getBoundingClientRect();
    for (let y = r.top + 20; y < r.bottom - 60; y += 15) {
      for (let x = r.left + 20; x < r.right - 60; x += 15) {
        if (document.elementFromPoint(x, y) === v.canvas && document.elementFromPoint(x + 40, y + 30) === v.canvas) {
          const a = v.toDoc(x - r.left, y - r.top), b = v.toDoc(x + 40 - r.left, y + 30 - r.top);
          return { x, y, dx: b.x - a.x, dy: b.y - a.y };
        }
      }
    }
    return null;
  });
  expect(pts).not.toBeNull();
  await page.mouse.move(pts.x, pts.y);
  await page.mouse.down();
  await page.mouse.move(pts.x + 20, pts.y + 15, { steps: 4 });
  await page.mouse.move(pts.x + 40, pts.y + 30, { steps: 4 });
  await page.mouse.up();
  const dist = Math.round(Math.hypot(pts.dx, pts.dy));
  const angle = Math.round((Math.atan2(pts.dy, -pts.dx) * 180) / Math.PI);
  const live = (await styles(page)).dropShadow;
  expect(live.distance).toBe(dist);
  expect(live.angle).toBe(angle);
  // the form shows the new values, and the dialog is still open (the click did not cancel it)
  await expect(pane(page).locator('input[type="number"][data-key="distance"]')).toHaveValue(String(dist));
  await expect(dialog(page)).toBeVisible();
  // the tool did not paint or move anything
  const active = await page.evaluate(() => { const l = window.pigmentApp.doc.active; return [l.x, l.y]; });
  expect(active).toEqual([0, 0]);
  await confirmDialog(page);
  const st = (await styles(page)).dropShadow;
  expect([st.distance, st.angle]).toEqual([dist, angle]);
  // the shadow lies where the drag put it: its corner below right of the rectangle's corner
  const a = (st.angle * Math.PI) / 180;
  const sx = Math.round(-Math.cos(a) * st.distance), sy = Math.round(Math.sin(a) * st.distance);
  expect(sx).toBeGreaterThan(0);
  expect(sy).toBeGreaterThan(0);
  expect(await pixel(page, 139 + sx, 99 + sy)).toEqual([0, 0, 0, 255]);
  expect(await pixel(page, 140 + sx, 100 + sy)).toEqual([0, 0, 0, 0]);
  expect(errors).toEqual([]);
});

test('instances, contours and the new fields round-trip a .pigment file', async ({ page }) => {
  const errors = await openApp(page);
  await blueRect(page);
  const r = await page.evaluate(async () => {
    const app = window.pigmentApp;
    const { writePigment, readPigment } = await import('/lib/io.js');
    const { setLayerProps } = await import('/lib/layer-ops.js');
    const cone = { name: 'Cone', points: [{ x: 0, y: 0, corner: false }, { x: 0.5, y: 1, corner: true }, { x: 1, y: 0, corner: false }] };
    const styles = {
      dropShadow: [{ enabled: true, distance: 6, size: 3, contour: cone, noise: 0.2 }, { enabled: true, distance: 3, angle: 0, color: '#ff0000', knocksOut: false }],
      outerGlow: { enabled: true, technique: 'precise', range: 0.3, fill: 'gradient', gradient: { gradientVersion: 2, type: 'solid', interpolation: 'perceptual', smoothness: 1, stops: [{ pos: 0, mid: 0.5, color: '#00ff00' }, { pos: 1, mid: 0.5, color: '#0000ff' }], opacityStops: [{ pos: 0, mid: 0.5, opacity: 1 }, { pos: 1, mid: 0.5, opacity: 0 }] } },
      bevel: { enabled: true, glossContour: cone, contourSub: { enabled: true, contour: cone, range: 0.4 } },
      stroke: [{ enabled: true, size: 2, fill: 'gradient', kind: 'shape-burst' }, { enabled: true, size: 4, position: 'inside', color: '#ffff00' }],
      hidden: false,
    };
    setLayerProps(app, app.doc.active, { styles }, 'Layer style');
    const d = app.doc;
    const before = d.view.compositor.composite(d).getContext('2d').getImageData(0, 0, 200, 160).data;
    const back = await readPigment(await writePigment(d));
    const layer = back.layers().find((l) => l.styles);
    return { same: JSON.stringify(layer.styles) === JSON.stringify(styles), drawn: before.some((v, i) => i % 4 === 3 && v > 0 && (Math.floor(i / 4) % 200 < 60)) };
  });
  expect(r).toEqual({ same: true, drawn: true });
  expect(errors).toEqual([]);
});
