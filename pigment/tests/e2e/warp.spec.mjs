// Warp, Perspective Warp and Puppet Warp (lib/warp.js over the engine in src/shared/pixels/warp.js):
// each one runs as a session of the Free Transform tool, commits on Enter through the history and
// restores the original pixels on Escape without leaving a history entry.
import { test, expect } from '@playwright/test';
import { openApp, newDoc, run, runAwait, pixel, drag, screenPoint, historyLength } from './helpers.mjs';

const paint = (page, color, rect) =>
  page.evaluate(([c, r]) => {
    const l = window.pigmentApp.doc.active;
    const ctx = l.canvas.getContext('2d');
    ctx.fillStyle = c;
    ctx.fillRect(...r);
    l.touch();
    window.pigmentApp.doc.changed('pixels', { layer: l });
  }, [color, rect]);

const session = (page) => page.evaluate(() => {
  const tt = window.pigmentApp.transformTool;
  return { active: !!tt.session, warp: tt.warp?.kind ?? null, tool: window.pigmentApp.tools.active.id };
});

const click = async (page, x, y, modifiers = []) => {
  const p = await screenPoint(page, x, y);
  await page.mouse.click(p.x, p.y, { modifiers });
};

const red = (p) => p[0] > 200 && p[1] < 60 && p[2] < 60 && p[3] > 200;
const clear = (p) => p[3] === 0;

test('Warp: the Arc preset bends a rectangle, Enter commits one undoable entry, the options bar toggles the mode', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { background: 'transparent' });
  await paint(page, '#ff0000', [100, 100, 200, 100]);
  const n = await historyLength(page);

  // the Free Transform options bar carries a Warp toggle; the command enters warp mode in place
  await runAwait(page, 'edit:free-transform');
  await expect(page.locator('#options-bar .warp-toggle')).toHaveAttribute('aria-pressed', 'false');
  await page.locator('#options-bar .warp-toggle').click();
  await expect.poll(() => session(page)).toEqual({ active: true, warp: 'bezier', tool: 'transform' });
  await expect(page.locator('#options-bar .warp-toggle')).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => window.pigmentApp.transformTool.warp.controls.length)).toBe(16);

  await page.selectOption('#options-bar select[data-key="warp-preset"]', 'arc');
  await expect.poll(() => page.evaluate(() => window.pigmentApp.transformTool.warp.changed)).toBe(true);
  // the preview already bends the box: the top edge rises in the middle, the bottom edge follows
  await expect.poll(async () => red(await pixel(page, 200, 80))).toBe(true);
  await page.keyboard.press('Enter');
  await expect.poll(() => session(page)).toEqual({ active: false, warp: null, tool: 'move' });
  expect(await historyLength(page)).toBe(n + 1);
  expect(red(await pixel(page, 200, 80))).toBe(true); // middle of the top edge moved up (was transparent)
  expect(clear(await pixel(page, 200, 190))).toBe(true); // middle of the bottom edge moved up too
  expect(red(await pixel(page, 200, 150))).toBe(true); // the body is still red
  expect(clear(await pixel(page, 95, 150))).toBe(true); // nothing spilled past the left edge
  expect(red(await pixel(page, 105, 150))).toBe(true);

  await runAwait(page, 'edit:undo');
  expect(await historyLength(page)).toBe(n);
  expect(clear(await pixel(page, 200, 80))).toBe(true);
  expect(red(await pixel(page, 200, 190))).toBe(true);
  expect(red(await pixel(page, 200, 105))).toBe(true);
  expect(errors).toEqual([]);
});

test('Warp: dragging a control point changes the mesh, Bend and the Custom preset follow, Escape cancels without a history entry', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { background: 'transparent' });
  await paint(page, '#ff0000', [100, 100, 200, 100]);
  const n = await historyLength(page);
  await runAwait(page, 'edit:transform-warp');
  await expect.poll(() => session(page)).toEqual({ active: true, warp: 'bezier', tool: 'transform' });
  // the top-left corner anchor sits on the box corner; dragging it pulls the pixels along
  await drag(page, [100, 100], [60, 60]);
  await expect.poll(() => page.evaluate(() => window.pigmentApp.transformTool.warp.preset)).toBe('custom');
  await expect.poll(() => page.evaluate(() => window.pigmentApp.transformTool.warp.controls[0].map(Math.round))).toEqual([60, 60]);
  await expect.poll(async () => red(await pixel(page, 70, 70))).toBe(true);
  // Bend applies to a geometric preset: the slider is disabled for a custom net
  await expect(page.locator('#options-bar input[type="number"][data-key="warp-bend"]')).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect.poll(() => session(page)).toEqual({ active: false, warp: null, tool: 'move' });
  expect(await historyLength(page)).toBe(n);
  expect(clear(await pixel(page, 70, 70))).toBe(true);
  expect(red(await pixel(page, 101, 101))).toBe(true);
  expect(errors).toEqual([]);
});

test('Warp refuses a text layer with a toast instead of rasterizing it silently', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { background: 'transparent' });
  await page.evaluate(async () => {
    const { TextLayer } = await import('/lib/document.js');
    const d = window.pigmentApp.doc;
    const l = new TextLayer({ name: 'Hello', text: 'Hello', x: 50, y: 50, font: { family: 'Arial', size: 36, color: '#0000ff' } });
    d.add(l, d.root, d.root.children.length);
    d.setActive(l);
    d.changed('tree');
  });
  const n = await historyLength(page);
  await runAwait(page, 'edit:transform-warp');
  await expect(page.locator('.toast')).toContainText(/Rasterize the text layer/);
  expect(await session(page)).toEqual({ active: false, warp: null, tool: 'move' });
  expect(await historyLength(page)).toBe(n);
  expect(errors).toEqual([]);
});

test('Perspective Warp: a laid-out quad warps the rectangle into a trapezoid, undo restores, Escape cancels', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { background: 'transparent' });
  await paint(page, '#ff0000', [100, 100, 200, 100]);
  const n = await historyLength(page);
  await runAwait(page, 'edit:perspective-warp');
  await expect.poll(() => session(page)).toEqual({ active: true, warp: 'perspective', tool: 'transform' });
  await expect(page.locator('#options-bar .seg-button[data-value="layout"]')).toHaveAttribute('aria-pressed', 'true');
  // layout: drag a quad over the rectangle
  await drag(page, [100, 100], [300, 200]);
  await expect.poll(() => page.evaluate(() => window.pigmentApp.transformTool.warp.quads.length)).toBe(1);
  // warp: pull the top corners inwards
  await page.locator('#options-bar .seg-button[data-value="warp"]').click();
  await expect(page.locator('#options-bar .seg-button[data-value="warp"]')).toHaveAttribute('aria-pressed', 'true');
  await drag(page, [100, 100], [140, 100]);
  await drag(page, [300, 100], [260, 100]);
  await expect.poll(() => page.evaluate(() => window.pigmentApp.transformTool.warp.changed)).toBe(true);
  await page.keyboard.press('Enter');
  await expect.poll(() => session(page)).toEqual({ active: false, warp: null, tool: 'move' });
  expect(await historyLength(page)).toBe(n + 1);
  expect(clear(await pixel(page, 120, 105))).toBe(true); // outside the slanted left edge near the top
  expect(clear(await pixel(page, 290, 105))).toBe(true); // outside the slanted right edge
  expect(red(await pixel(page, 200, 105))).toBe(true); // the top edge is still red in the middle
  expect(red(await pixel(page, 110, 195))).toBe(true); // the bottom corners did not move
  expect(red(await pixel(page, 290, 195))).toBe(true);
  await runAwait(page, 'edit:undo');
  expect(await historyLength(page)).toBe(n);
  expect(red(await pixel(page, 120, 105))).toBe(true);

  // Escape in warp mode drops the pending warp without an entry
  await runAwait(page, 'edit:perspective-warp');
  await drag(page, [100, 100], [300, 200]);
  await page.keyboard.press('Enter'); // Enter in layout mode switches to warp mode
  await expect.poll(() => page.evaluate(() => window.pigmentApp.transformTool.warp?.mode)).toBe('warp');
  await drag(page, [100, 100], [160, 100]);
  await expect.poll(async () => clear(await pixel(page, 120, 105))).toBe(true);
  await page.keyboard.press('Escape');
  await expect.poll(() => session(page)).toEqual({ active: false, warp: null, tool: 'move' });
  expect(await historyLength(page)).toBe(n);
  expect(red(await pixel(page, 120, 105))).toBe(true);
  expect(errors).toEqual([]);
});

test('Puppet Warp: two pins, dragging one moves the pixels near it and not the pinned side; Delete removes a pin; Escape cancels', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { background: 'transparent' });
  await paint(page, '#ff0000', [100, 120, 200, 60]);
  const n = await historyLength(page);
  await runAwait(page, 'edit:puppet-warp');
  await expect.poll(() => session(page)).toEqual({ active: true, warp: 'puppet', tool: 'transform' });
  // the mesh covers the opaque cells only
  const mesh = await page.evaluate(() => {
    const m = window.pigmentApp.transformTool.warp.meshInfo;
    return { cells: m.cols * m.rows, marked: m.cells.reduce((a, b) => a + b, 0) };
  });
  expect(mesh.marked).toBeGreaterThan(0);
  expect(mesh.marked).toBeLessThanOrEqual(mesh.cells);
  await page.selectOption('#options-bar select[data-key="puppet-mode"]', 'rigid');
  await click(page, 120, 150);
  await click(page, 280, 150);
  await expect.poll(() => page.evaluate(() => window.pigmentApp.transformTool.warp.pins.length)).toBe(2);
  // drag the right pin 100 px to the right: the right end stretches over, the left end stays put
  await drag(page, [280, 150], [380, 150]);
  await expect.poll(() => page.evaluate(() => Math.round(window.pigmentApp.transformTool.warp.pins[1].tx))).toBe(380);
  await page.keyboard.press('Enter');
  await expect.poll(() => session(page)).toEqual({ active: false, warp: null, tool: 'move' });
  expect(await historyLength(page)).toBe(n + 1);
  expect(red(await pixel(page, 370, 150))).toBe(true); // pixels followed the moved pin
  expect(red(await pixel(page, 205, 150))).toBe(true); // the middle is still covered
  expect(red(await pixel(page, 120, 150))).toBe(true); // the pinned side did not move
  expect(red(await pixel(page, 103, 150))).toBe(true);
  expect(clear(await pixel(page, 96, 150))).toBe(true); // nothing moved past the pinned end
  await runAwait(page, 'edit:undo');
  expect(await historyLength(page)).toBe(n);
  expect(clear(await pixel(page, 370, 150))).toBe(true);
  expect(red(await pixel(page, 290, 150))).toBe(true);

  // Delete removes the selected pin; Escape restores the pixels without an entry
  await runAwait(page, 'edit:puppet-warp');
  await click(page, 120, 150);
  await click(page, 280, 150);
  await expect.poll(() => page.evaluate(() => window.pigmentApp.transformTool.warp.pins.length)).toBe(2);
  await page.keyboard.press('Delete');
  await expect.poll(() => page.evaluate(() => window.pigmentApp.transformTool.warp.pins.length)).toBe(1);
  await drag(page, [120, 150], [120, 60]); // one pin alone translates everything
  await expect.poll(async () => red(await pixel(page, 200, 60))).toBe(true);
  await page.keyboard.press('Escape');
  await expect.poll(() => session(page)).toEqual({ active: false, warp: null, tool: 'move' });
  expect(await historyLength(page)).toBe(n);
  expect(clear(await pixel(page, 200, 60))).toBe(true);
  expect(red(await pixel(page, 200, 150))).toBe(true);
  expect(errors).toEqual([]);
});

test('Puppet Warp: Alt-drag rotates around a pin', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { background: 'transparent' });
  await paint(page, '#ff0000', [100, 140, 200, 20]);
  await runAwait(page, 'edit:puppet-warp');
  await click(page, 110, 150);
  await click(page, 290, 150);
  await expect.poll(() => page.evaluate(() => window.pigmentApp.transformTool.warp.pins.length)).toBe(2);
  // rotate about the right pin: Alt-drag from above the pin to its right (a quarter turn)
  await drag(page, [290, 150], [340, 150], { modifiers: ['Alt'] });
  const angle = await page.evaluate(() => window.pigmentApp.transformTool.warp.pins[1].angle);
  expect(Math.abs(angle)).toBeGreaterThan(0);
  // the pin itself stayed put while the mesh around it turned
  const pin = await page.evaluate(() => window.pigmentApp.transformTool.warp.pins[1]);
  expect(Math.round(pin.tx)).toBe(290);
  expect(Math.round(pin.ty)).toBe(150);
  await page.keyboard.press('Escape');
  await expect.poll(() => session(page)).toEqual({ active: false, warp: null, tool: 'move' });
  expect(errors).toEqual([]);
});

test('Edit › Transform › Warp is enabled with a raster layer and the native menu names it', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  const enabled = await page.evaluate(() => ['edit:transform-warp', 'edit:perspective-warp', 'edit:puppet-warp'].map((id) => window.pigmentApp.commands.isEnabled(id)));
  expect(enabled).toEqual([true, true, true]);
  // the warp toggle is checked only while a Bézier warp session runs
  expect(await page.evaluate(() => window.pigmentApp.commands.get('edit:transform-warp').checked())).toBe(false);
  await run(page, 'edit:transform-warp');
  await expect.poll(() => page.evaluate(() => window.pigmentApp.commands.get('edit:transform-warp').checked())).toBe(true);
  await page.keyboard.press('Escape');
  expect(errors).toEqual([]);
});
