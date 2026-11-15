// brush-painting-behaviours (ARCHITECTURE.md "0.5 features", package 3; port 8853): the paint gestures through real
// pointer and key events — Shift-click lines (one history entry, the DabTools too, 16-bit documents), the Shift axis
// lock, the digits (the Brush's opacity and flow, the layer's with the Move tool), the mode keys, the preset keys,
// the brush-resize HUD past the temporary Eyedropper (Alt) and past the temporary Move tool (Ctrl, macOS), the HUD
// colour picker gesture, the tilde, the pen's eraser end, the arrow keys and the cursors.
import { test, expect } from '@playwright/test';
import { openApp, newDoc, runAwait, screenPoint, historyLength } from './helpers.mjs';

const labels = (page) => page.evaluate(() => window.pigmentApp.doc.history.entries.slice(0, window.pigmentApp.doc.history.index + 1).map((e) => e.label));
const opt = (page, tool, key) => page.evaluate(([t, k]) => window.pigmentApp.tools.opt(t, k), [tool, key]);
const unfocus = (page) => page.evaluate(() => document.activeElement?.blur?.());
/** Red channel of the active layer at a document point (255 on white, 0 where black paint is). */
const red = (page, x, y) =>
  page.evaluate(([px, py]) => {
    const l = window.pigmentApp.doc.active;
    return l.canvas.getContext('2d').getImageData(px - l.x, py - l.y, 1, 1).data[0];
  }, [x, y]);
const alphaAt = (page, x, y) =>
  page.evaluate(([px, py]) => {
    const l = window.pigmentApp.doc.active;
    return l.canvas.getContext('2d').getImageData(px - l.x, py - l.y, 1, 1).data[3];
  }, [x, y]);

async function brushSetup(page, tool = 'brush', opts = {}) {
  await page.evaluate(([t, o]) => {
    const app = window.pigmentApp;
    app.tools.activate(t);
    for (const [k, v] of Object.entries({ size: 10, hardness: 1, smoothing: 0, pressureSize: false, ...o })) if (app.tools.get(t).options.some((x) => x.key === k)) app.tools.setOpt(t, k, v);
    app.setColors({ foreground: '#000000', background: '#ffffff' });
  }, [tool, opts]);
}

async function click(page, x, y, { modifiers = [] } = {}) {
  const p = await screenPoint(page, x, y);
  for (const m of modifiers) await page.keyboard.down(m);
  await page.mouse.click(p.x, p.y);
  for (const m of modifiers) await page.keyboard.up(m);
}

test('a Shift-click line is one history entry that undoes and redoes; Shift-drag keeps to its axis; DabTools and 16-bit take lines', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 400, height: 300, background: 'white' });
  await brushSetup(page);
  const n0 = await historyLength(page);
  await click(page, 50, 50);
  await click(page, 300, 200, { modifiers: ['Shift'] });
  expect(await historyLength(page)).toBe(n0 + 2);
  expect((await labels(page)).slice(-2)).toEqual(['Brush', 'Brush']);
  // on the line from (50, 50) to (300, 200), not beside it
  expect(await red(page, 175, 125)).toBeLessThan(40);
  expect(await red(page, 175, 100)).toBe(255);
  await runAwait(page, 'edit:undo');
  expect(await red(page, 175, 125)).toBe(255);
  expect(await red(page, 50, 50)).toBeLessThan(40);
  await runAwait(page, 'edit:redo');
  expect(await red(page, 175, 125)).toBeLessThan(40);
  // the next Shift-click goes on from where the line ended
  await click(page, 300, 60, { modifiers: ['Shift'] });
  expect(await red(page, 300, 130)).toBeLessThan(40);
  expect(await historyLength(page)).toBe(n0 + 3);

  // Shift-drag: the stroke keeps to the axis it first moved along, however the pointer wanders
  await newDoc(page, { width: 400, height: 300, background: 'white' });
  await brushSetup(page);
  const a = await screenPoint(page, 60, 150), b = await screenPoint(page, 340, 210);
  await page.keyboard.down('Shift');
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(a.x + 40, a.y + 2, { steps: 4 });
  await page.mouse.move(b.x, b.y, { steps: 10 });
  await page.mouse.up();
  await page.keyboard.up('Shift');
  expect(await red(page, 300, 150)).toBeLessThan(40);
  expect(await red(page, 300, 200)).toBe(255);
  expect(await historyLength(page)).toBe(1);

  // a DabTool (Burn): the Shift-click line is one entry with the tool's label
  await newDoc(page, { width: 300, height: 200, background: 'white' });
  await page.evaluate(() => window.pigmentApp.setColors({ foreground: '#808080' }));
  await runAwait(page, 'edit:fill-foreground');
  await brushSetup(page, 'burn', { size: 12, exposure: 1, range: 'midtones' });
  const nb = await historyLength(page);
  await click(page, 40, 40);
  await click(page, 260, 160, { modifiers: ['Shift'] });
  expect(await historyLength(page)).toBe(nb + 2);
  expect((await labels(page)).slice(-1)).toEqual(['Burn']);
  expect(await red(page, 150, 100)).toBeLessThan(120);
  expect(await red(page, 150, 60)).toBe(128);

  // 16-bit: the line paints the proxy and the deep pixels follow, one entry
  await newDoc(page, { width: 200, height: 120, background: 'white', depth: 16 });
  await brushSetup(page);
  await click(page, 20, 60);
  await click(page, 180, 60, { modifiers: ['Shift'] });
  expect(await historyLength(page)).toBe(2);
  const deep = await page.evaluate(() => {
    const app = window.pigmentApp;
    const l = app.doc.active;
    app.deep.sync(app.doc);
    const o = (60 * l.canvas.width + 100) * 4;
    return { type: l.deep.type, at: Array.from(l.deep.data.subarray(o, o + 4)) };
  });
  expect(deep).toEqual({ type: 'u16', at: [0, 0, 0, 65535] });

  // Grayscale: a red foreground paints the line grey (the image mode's colour constraint)
  await newDoc(page, { width: 200, height: 120, background: 'white' });
  await runAwait(page, 'image:mode', { mode: 'grayscale', silent: true, flatten: true });
  await brushSetup(page);
  await page.evaluate(() => window.pigmentApp.setColors({ foreground: '#ff0000' }));
  await click(page, 20, 60);
  await click(page, 180, 60, { modifiers: ['Shift'] });
  const grey = await page.evaluate(() => {
    const l = window.pigmentApp.doc.active;
    return Array.from(l.canvas.getContext('2d').getImageData(100 - l.x, 60 - l.y, 1, 1).data);
  });
  expect(grey[0]).toBeLessThan(200);
  expect([grey[1], grey[2]]).toEqual([grey[0], grey[0]]);
  expect(errors).toEqual([]);
});

test('digits set the Brush\'s opacity (two quick digits: exact), Shift+digits its flow; with the Move tool the layer\'s; mode and preset keys', async ({ page }) => {
  const errors = await openApp(page);
  // a transparent document: its layer is not a Background, so the Move tool's digits may change it
  await newDoc(page, { width: 300, height: 200, background: 'transparent' });
  await brushSetup(page);
  await unfocus(page);
  await page.keyboard.press('5');
  await expect.poll(() => opt(page, 'brush', 'opacity')).toBe(0.5);
  await page.waitForTimeout(700);
  await page.keyboard.press('4');
  await page.keyboard.press('5');
  await expect.poll(() => opt(page, 'brush', 'opacity')).toBe(0.45);
  await page.waitForTimeout(700);
  await page.keyboard.press('0');
  await expect.poll(() => opt(page, 'brush', 'opacity')).toBe(1);
  await page.keyboard.press('Shift+3');
  await expect.poll(() => opt(page, 'brush', 'flow')).toBe(0.3);
  // the options bar shows it
  await expect(page.locator('#options-bar .opt[data-key="opacity"] input').first()).toHaveValue(/^(1|100)$/);
  // the layer kept its opacity, and painting added nothing to the history
  expect(await page.evaluate(() => window.pigmentApp.doc.active.opacity)).toBe(1);
  expect(await historyLength(page)).toBe(0);

  // Shift+Alt+M: the Brush's mode (the layer's stays Normal); Behind and Clear have their own keys
  await page.keyboard.press('Shift+Alt+M');
  await expect.poll(() => opt(page, 'brush', 'blend')).toBe('multiply');
  await page.keyboard.press('Shift+Alt+Q');
  await expect.poll(() => opt(page, 'brush', 'blend')).toBe('behind');
  await page.keyboard.press('Shift+Alt+N');
  await expect.poll(() => opt(page, 'brush', 'blend')).toBe('normal');
  expect(await page.evaluate(() => window.pigmentApp.doc.active.blend)).toBe('normal');

  // , and . step through the brush presets; Shift+, the first
  const ids = await page.evaluate(async () => {
    await window.pigmentApp.presets.ready('brushes');
    return window.pigmentApp.presets.list('brushes').map((p) => p.id);
  });
  expect(ids.length).toBeGreaterThan(2);
  const presetId = () => page.evaluate(() => window.pigmentApp.settings.tools?.brush?.brushPresetId ?? null);
  await page.keyboard.press('Shift+Comma');
  await expect.poll(presetId).toBe(ids[0]);
  await page.keyboard.press('Period');
  await expect.poll(presetId).toBe(ids[1]);
  await page.keyboard.press('Comma');
  await expect.poll(presetId).toBe(ids[0]);
  await page.keyboard.press('Comma');
  await expect.poll(presetId).toBe(ids[ids.length - 1]);
  await page.keyboard.press('Shift+Period');
  await expect.poll(presetId).toBe(ids[ids.length - 1]);
  const size = await opt(page, 'brush', 'size');
  const stored = await page.evaluate((id) => window.pigmentApp.presets.get('brushes', id).data.tip.size, ids[ids.length - 1]);
  expect(size).toBe(stored);

  // the Move tool: the digits are the layer's again (0.4), and Shift+Alt+M the layer's mode
  await page.evaluate(() => window.pigmentApp.tools.activate('move'));
  await page.waitForTimeout(700);
  await page.keyboard.press('3');
  await expect.poll(() => page.evaluate(() => window.pigmentApp.doc.active.opacity)).toBe(0.3);
  expect(await opt(page, 'brush', 'opacity')).toBe(1);
  await page.keyboard.press('Shift+Alt+M');
  await expect.poll(() => page.evaluate(() => window.pigmentApp.doc.active.blend)).toBe('multiply');
  expect(await opt(page, 'brush', 'blend')).toBe('normal');

  // the Pencil has no flow: Shift+digit does nothing to the tool or the layer
  await page.evaluate(() => window.pigmentApp.tools.activate('pencil'));
  await page.keyboard.press('Shift+4');
  await page.keyboard.press('7');
  await expect.poll(() => opt(page, 'pencil', 'opacity')).toBe(0.7);
  expect(await page.evaluate(() => window.pigmentApp.doc.active.fillOpacity ?? 1)).toBe(1);
  // a DabTool's amount: the Blur tool's Strength
  await page.evaluate(() => window.pigmentApp.tools.activate('blur'));
  await page.waitForTimeout(700);
  await page.keyboard.press('2');
  await expect.poll(() => opt(page, 'blur', 'strength')).toBe(0.2);
  // a replayed step carries its value
  await page.evaluate(() => window.pigmentApp.tools.activate('brush'));
  await runAwait(page, 'tool:opacity-digit-1', { tool: 'brush', key: 'opacity', value: 0.37 }, 'action');
  expect(await opt(page, 'brush', 'opacity')).toBe(0.37);
  // a text field keeps its digits
  await page.evaluate(() => {
    const i = document.createElement('input');
    i.id = 'probe';
    document.body.append(i);
    i.focus();
  });
  await page.keyboard.press('9');
  await page.waitForTimeout(100);
  expect(await opt(page, 'brush', 'opacity')).toBe(0.37);
  expect(errors).toEqual([]);
});

test('Alt held then right-drag resizes past the temporary Eyedropper; Escape restores; no history entry, no colour sampled', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 400, height: 300, background: 'white' });
  await brushSetup(page, 'brush', { size: 20, hardness: 0.5 });
  await page.evaluate(() => window.pigmentApp.setColors({ foreground: '#123456' }));
  await page.evaluate(() => window.pigmentApp.view.setZoom(1));
  const c = await screenPoint(page, 200, 150);
  await page.mouse.move(c.x, c.y);
  await page.keyboard.down('Alt');
  await expect.poll(() => page.evaluate(() => window.pigmentApp.view.tempTool?.id ?? null)).toBe('eyedropper');
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(c.x + 30, c.y - 50, { steps: 5 });
  // while dragging: the HUD is up and the values follow
  expect(await page.evaluate(() => window.pigmentApp.tools.active.gesture.hud?.kind ?? null)).toBe('resize');
  expect(await opt(page, 'brush', 'size')).toBe(80);
  expect(await opt(page, 'brush', 'hardness')).toBe(0.75);
  await page.mouse.up({ button: 'right' });
  await page.keyboard.up('Alt');
  const r = await page.evaluate(() => ({ fg: window.pigmentApp.settings.foreground, temp: window.pigmentApp.view.tempTool?.id ?? null, hud: window.pigmentApp.tools.active.gesture.hud, entries: window.pigmentApp.doc.history.index + 1 }));
  expect(r).toEqual({ fg: '#123456', temp: null, hud: null, entries: 0 });
  expect(await opt(page, 'brush', 'size')).toBe(80);
  await expect(page.locator('#options-bar .opt[data-key="size"] input').first()).toHaveValue('80');

  // Escape mid-drag puts the values back (no temporary tool: the Eraser has no Alt Eyedropper)
  await brushSetup(page, 'eraser', { size: 30, hardness: 0.5 });
  await page.mouse.move(c.x, c.y);
  await page.keyboard.down('Alt');
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(c.x + 40, c.y, { steps: 4 });
  expect(await opt(page, 'eraser', 'size')).toBe(110);
  await page.keyboard.press('Escape');
  await page.mouse.up({ button: 'right' });
  await page.keyboard.up('Alt');
  expect(await opt(page, 'eraser', 'size')).toBe(30);
  expect(await opt(page, 'eraser', 'hardness')).toBe(0.5);
  // the vertical drag can set the opacity instead (Preferences > Cursors)
  await page.evaluate(() => {
    const app = window.pigmentApp;
    app.saveSettingsSoon({ painting: { ...app.settings.painting, hud: { vertical: 'opacity' } } });
  });
  await brushSetup(page, 'brush', { size: 20, opacity: 1 });
  await page.mouse.move(c.x, c.y);
  await page.keyboard.down('Alt');
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(c.x, c.y + 100, { steps: 4 });
  await page.mouse.up({ button: 'right' });
  await page.keyboard.up('Alt');
  expect(await opt(page, 'brush', 'opacity')).toBe(0.5);
  expect(errors).toEqual([]);
});

test('macOS: Ctrl held then Ctrl+Alt-drag resizes and does not move the layer; Ctrl+Alt+Cmd-drag opens the HUD colour picker', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 400, height: 300, background: 'white' });
  await brushSetup(page, 'brush', { size: 20, hardness: 1 });
  await page.evaluate(async () => {
    const { PaintGesture } = await import('/lib/tools/paint-gesture.js');
    PaintGesture.mac = true;
    window.pigmentApp.view.setZoom(1);
  });
  const c = await screenPoint(page, 200, 150);
  await page.mouse.move(c.x, c.y);
  await page.keyboard.down('Control');
  await expect.poll(() => page.evaluate(() => window.pigmentApp.view.tempTool?.id ?? null)).toBe('move');
  await page.keyboard.down('Alt');
  await page.mouse.down();
  await page.mouse.move(c.x + 25, c.y, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.up('Alt');
  await page.keyboard.up('Control');
  const r = await page.evaluate(() => {
    const app = window.pigmentApp;
    const l = app.doc.active;
    return { x: l.x, y: l.y, entries: app.doc.history.entries.map((e) => e.label), size: app.tools.opt('brush', 'size'), temp: app.view.tempTool?.id ?? null };
  });
  expect(r).toEqual({ x: 0, y: 0, entries: [], size: 70, temp: null });

  // Ctrl+Alt+Cmd-drag: the gesture opens the picker's HUD session and forwards to it (a recording session stands in
  // for color-picker-swatches' here; the stub's resolves null and changes nothing)
  const log = await page.evaluate(async () => {
    const app = window.pigmentApp;
    const real = app.colorPicker.hud;
    const calls = [];
    app.colorPicker.hud = (o) => {
      calls.push(['open', o.tool.id, o.initial]);
      const s = real.call(app.colorPicker, o);
      return { move: (p) => calls.push(['move']), up: (p) => { calls.push(['up']); s.up(p); }, cancel: () => { calls.push(['cancel']); s.cancel(); }, done: s.done };
    };
    window.__hudCalls = calls;
    window.__restoreHud = () => (app.colorPicker.hud = real);
    return calls;
  });
  expect(log).toEqual([]);
  await page.keyboard.down('Control');
  await page.keyboard.down('Alt');
  await page.keyboard.down('Meta');
  await page.mouse.down();
  await page.mouse.move(c.x + 10, c.y + 10, { steps: 3 });
  await page.mouse.up();
  await page.keyboard.up('Meta');
  await page.keyboard.up('Alt');
  await page.keyboard.up('Control');
  const calls = await page.evaluate(() => {
    window.__restoreHud();
    return window.__hudCalls;
  });
  expect(calls[0]).toEqual(['open', 'brush', '#000000']);
  expect(calls.filter((x) => x[0] === 'move').length).toBeGreaterThan(0);
  expect(calls[calls.length - 1]).toEqual(['up']);
  expect(await page.evaluate(() => ({ fg: window.pigmentApp.settings.foreground, entries: window.pigmentApp.doc.history.index + 1, size: window.pigmentApp.tools.opt('brush', 'size') }))).toEqual({ fg: '#000000', entries: 0, size: 70 });
  await page.evaluate(async () => {
    const { PaintGesture } = await import('/lib/tools/paint-gesture.js');
    PaintGesture.mac = false;
  });
  expect(errors).toEqual([]);
});

test('Windows and Linux: Alt+Shift+right-drag forwards to the HUD colour picker session; Escape cancels it', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 300, height: 200, background: 'white' });
  await brushSetup(page);
  await page.evaluate(() => {
    const app = window.pigmentApp;
    const real = app.colorPicker.hud;
    window.__hudCalls = [];
    app.colorPicker.hud = (o) => {
      window.__hudCalls.push(['open', o.at.x > 0 && o.at.y > 0]);
      const s = real.call(app.colorPicker, o);
      return { move: () => window.__hudCalls.push(['move']), up: (p) => { window.__hudCalls.push(['up']); s.up(p); }, cancel: () => { window.__hudCalls.push(['cancel']); s.cancel(); }, done: s.done };
    };
  });
  const c = await screenPoint(page, 150, 100);
  await page.mouse.move(c.x, c.y);
  await page.keyboard.down('Alt');
  await page.keyboard.down('Shift');
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(c.x + 20, c.y, { steps: 2 });
  await page.keyboard.press('Escape');
  await page.mouse.up({ button: 'right' });
  await page.keyboard.up('Shift');
  await page.keyboard.up('Alt');
  const calls = await page.evaluate(() => window.__hudCalls);
  expect(calls[0]).toEqual(['open', true]);
  expect(calls.some((x) => x[0] === 'move')).toBe(true);
  expect(calls[calls.length - 1]).toEqual(['cancel']);
  expect(await historyLength(page)).toBe(0);
  // the stub session (until color-picker-swatches lands, review decision 2): nothing changes
  const landed = await page.evaluate(() => !!window.pigmentApp.colorPicker.real);
  if (!landed) expect(await page.evaluate(() => window.pigmentApp.settings.foreground)).toBe('#000000');
  expect(errors).toEqual([]);
});

test('held tilde erases with the Brush; a pen eraser stroke erases and the Brush stays the tool; arrows turn the tip', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 300, height: 200, background: 'white' });
  await brushSetup(page, 'brush', { size: 16 });
  // a layer of black to erase from
  await page.evaluate(async () => {
    const app = window.pigmentApp;
    const { RasterLayer, createCanvas } = await import('/lib/document.js');
    const { structural } = await import('/lib/layer-ops.js');
    const cv = createCanvas(300, 200);
    cv.getContext('2d').fillRect(0, 0, 300, 200);
    const layer = new RasterLayer({ name: 'Ink', canvas: cv, x: 0, y: 0 });
    structural(app, 'Add', () => {
      app.doc.add(layer);
      app.doc.setActive(layer);
    });
  });
  await unfocus(page);
  const n = await historyLength(page);
  await page.keyboard.down('Backquote');
  const a = await screenPoint(page, 40, 50), b = await screenPoint(page, 200, 50);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.up('Backquote');
  expect(await alphaAt(page, 120, 50)).toBe(0);
  expect(await alphaAt(page, 120, 120)).toBe(255);
  expect(await historyLength(page)).toBe(n + 1);
  // released: the Brush paints again
  await page.evaluate(() => window.pigmentApp.setColors({ foreground: '#ff0000' }));
  await click(page, 120, 50);
  expect(await page.evaluate(() => Array.from(window.pigmentApp.doc.active.canvas.getContext('2d').getImageData(120, 50, 1, 1).data))).toEqual([255, 0, 0, 255]);

  // the pen's eraser end (button 5 / buttons 32): the Eraser's stroke, with the Eraser's brush; the Brush stays
  await page.evaluate(() => {
    window.pigmentApp.tools.setOpt('eraser', 'size', 30);
    window.pigmentApp.tools.setOpt('eraser', 'hardness', 1);
  });
  const pen = await page.evaluate(async ([x0, y0, x1]) => {
    const app = window.pigmentApp;
    const canvas = document.querySelector('.doc-frame:not([hidden]) canvas.view');
    const o = { bubbles: true, cancelable: true, composed: true, pointerId: 1, pointerType: 'pen', isPrimary: true, clientX: x0, clientY: y0, pressure: 1 };
    canvas.dispatchEvent(new PointerEvent('pointerdown', { ...o, button: 5, buttons: 32 }));
    for (let i = 1; i <= 6; i++) canvas.dispatchEvent(new PointerEvent('pointermove', { ...o, clientX: x0 + ((x1 - x0) * i) / 6, button: -1, buttons: 32 }));
    canvas.dispatchEvent(new PointerEvent('pointerup', { ...o, clientX: x1, button: 5, buttons: 0 }));
    return { tool: app.tools.active.id, label: app.doc.history.entries[app.doc.history.index].label };
  }, [(await screenPoint(page, 40, 150)).x, (await screenPoint(page, 40, 150)).y, (await screenPoint(page, 200, 150)).x]);
  expect(pen).toEqual({ tool: 'brush', label: 'Eraser' });
  expect(await alphaAt(page, 120, 150)).toBe(0);
  // the Eraser's 30 px brush, not the Brush's 16 px
  expect(await alphaAt(page, 120, 161)).toBe(0);

  // Right arrow turns the tip clockwise by 1 degree, Shift+Right by 15, Left back; the angle wraps at 180
  await unfocus(page);
  await page.evaluate(() => window.pigmentApp.tools.setOpt('brush', 'angle', 0));
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => opt(page, 'brush', 'angle')).toBe(1);
  await page.keyboard.press('Shift+ArrowRight');
  await expect.poll(() => opt(page, 'brush', 'angle')).toBe(16);
  await page.keyboard.press('ArrowLeft');
  await expect.poll(() => opt(page, 'brush', 'angle')).toBe(15);
  await page.evaluate(() => window.pigmentApp.tools.setOpt('brush', 'angle', 175));
  await page.keyboard.press('Shift+ArrowRight');
  await expect.poll(() => opt(page, 'brush', 'angle')).toBe(-170);
  expect(await page.evaluate(async () => (await import('/lib/brush/tool-brush.js')).toolBrush(window.pigmentApp, 'brush').preset.tip.angle)).toBe(-170);
  expect(errors).toEqual([]);
});

test('cursors: the real tip outline (angle, roundness, Normal vs Full Size), Caps Lock and Other Cursors, the Cursors preferences', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 400, height: 300, background: 'white' });
  await brushSetup(page, 'brush', { size: 100, hardness: 0 });
  const box = await page.evaluate(async () => {
    const app = window.pigmentApp;
    app.view.setZoom(1);
    app.view.pointer = { x: 200, y: 150 };
    // a recording context: the outline's extent in screen px around the pointer
    const pts = [];
    const ctx = new Proxy({}, {
      get: (t, k) => {
        if (k === 'moveTo' || k === 'lineTo') return (x, y) => pts.push([x, y]);
        if (k === 'getTransform') return () => new DOMMatrix();
        return typeof t[k] === 'function' || !(k in t) ? () => {} : t[k];
      },
      set: (t, k, v) => ((t[k] = v), true),
    });
    const tool = app.tools.get('brush');
    const extent = () => {
      pts.length = 0;
      tool.drawOverlay(ctx, app.view);
      const c = app.view.toScreen(200, 150);
      const xs = pts.map((p) => p[0] - c.x), ys = pts.map((p) => p[1] - c.y);
      return pts.length ? [Math.round(Math.max(...xs) - Math.min(...xs)), Math.round(Math.max(...ys) - Math.min(...ys))] : null;
    };
    app.settings.cursorStyle = 'full';
    const full = extent();
    app.settings.cursorStyle = 'outline';
    const normal = extent();
    app.settings.cursorStyle = 'full';
    app.tools.setOpt('brush', 'roundness', 0.25);
    app.tools.setOpt('brush', 'angle', 90);
    const turned = extent();
    app.settings.cursorStyle = 'precise';
    const precise = extent();
    return { full, normal, turned, precise, css: app.view.canvas.style.cursor };
  });
  expect(box.full).toEqual([100, 100]);
  expect(box.normal).toEqual([50, 50]);
  // 25 px wide, 100 px tall: the flat tip stood up
  expect(box.turned[0]).toBeLessThan(30);
  expect(box.turned[1]).toBeGreaterThan(95);
  expect(box.precise).toBe(null);

  // Caps Lock: the painting cursor becomes the crosshair; Other Cursors: Precise gives the arrow tools the crosshair
  const css = await page.evaluate(async () => {
    const app = window.pigmentApp;
    const { paintKeyState } = await import('/lib/tools/paint-gesture.js');
    app.settings.cursorStyle = 'outline';
    app.tools.updateCursor();
    const plain = app.view.canvas.style.cursor;
    paintKeyState.capsLock = true;
    app.tools.updateCursor();
    const caps = app.view.canvas.style.cursor;
    paintKeyState.capsLock = false;
    app.tools.updateCursor();
    app.view.setCursor('default');
    const arrow = app.view.canvas.style.cursor;
    app.settings.painting = { ...app.settings.painting, cursors: { ...app.settings.painting.cursors, other: 'precise' } };
    app.tools.activate('marquee-rect');
    app.view.setCursor('default');
    const precise = app.view.canvas.style.cursor;
    app.view.setCursor('grab');
    return { plain, caps, arrow, precise, grab: app.view.canvas.style.cursor };
  });
  expect(css).toEqual({ plain: 'none', caps: 'crosshair', arrow: 'default', precise: 'crosshair', grab: 'grab' });

  // the Cursors section of Preferences: its fields, written to settings.painting
  await page.evaluate(() => {
    const app = window.pigmentApp;
    app.settings.painting = { ...app.settings.painting, cursors: { ...app.settings.painting.cursors, other: 'standard' } };
  });
  await page.evaluate(() => {
    window.__prefs = window.pigmentApp.preferencesDialog();
  });
  await expect(page.locator('.prefs-dialog .section', { hasText: /^Cursors$/ })).toHaveCount(1);
  await expect(page.locator('.prefs-dialog [data-key="paintingCrosshairInTip"]')).toHaveCount(1);
  await expect(page.locator('.prefs-dialog [data-key="cursorStyle"]')).toHaveCount(1);
  await page.locator('.prefs-dialog [data-key="paintingCrosshairInTip"]').check();
  await page.locator('.prefs-dialog select[data-key="paintingOtherCursors"]').selectOption('precise');
  await page.locator('.dialog-backdrop .dialog-buttons .btn.primary').last().click();
  await expect.poll(() => page.evaluate(() => window.pigmentApp.settings.painting.cursors)).toMatchObject({ crosshairInTip: true, other: 'precise', previewColor: '#ff0000' });
  expect(errors).toEqual([]);
});
