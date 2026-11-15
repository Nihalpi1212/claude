// brush-engine-core (ARCHITECTURE.md "0.5 features", package 1; port 8851): the engine in the app — pen samples with
// tilt, twist and wheel, Define Brush Preset and its sampled tip, Behind / Clear / Dissolve, Transfer's opacity
// ceiling, 16-bit, Grayscale and Indexed documents, scattered dabs growing a lazily grown layer, the airbrush (build-up
// with its own ticks) and the smoothing options, each stroke one history entry that undoes and redoes.
import { test, expect } from '@playwright/test';
import { openApp, newDoc, runAwait } from './helpers.mjs';

/**
 * Installs window.__paint(tool, preset | null, points, { opts, partial }) in the page: the tool gets the preset as its
 * brush (when given) and the options, then one stroke through its pointer handlers (down, moves, up), as the canvas
 * would send them. Returns the history labels added.
 */
async function kit(page) {
  await page.evaluate(async () => {
    const app = window.pigmentApp;
    const { setToolBrush, toolBrush } = await import('/lib/brush/tool-brush.js');
    const { normalizeBrush } = await import('/lib/brush/preset.js');
    window.__brush = { setToolBrush, toolBrush, normalizeBrush };
    window.__paint = (toolId, preset, points, opts = {}) => {
      app.tools.activate(toolId);
      if (preset) setToolBrush(app, toolId, normalizeBrush(preset), { includeTool: false, respectLocks: false });
      for (const [k, v] of Object.entries(opts)) app.tools.setOpt(toolId, k, v);
      const tool = app.tools.get(toolId);
      const h = app.doc.history;
      const before = h.index;
      const at = (p) => ({ pressure: 1, button: 0, buttons: 1, ...p });
      tool.onPointerDown(at(points[0]));
      for (const p of points.slice(1)) tool.onPointerMove(at(p), true);
      tool.onPointerUp(at(points[points.length - 1]));
      return h.entries.slice(before + 1, h.index + 1).map((e) => e.label);
    };
    window.__alpha = (x, y, layer = app.doc.active) => layer.canvas.getContext('2d').getImageData(x - layer.x, y - layer.y, 1, 1).data[3];
    window.__rgba = (x, y, layer = app.doc.active) => Array.from(layer.canvas.getContext('2d').getImageData(x - layer.x, y - layer.y, 1, 1).data);
  });
}

test('pen samples: the barrel rotation turns the tip, the wheel sizes it, the tilt squashes it (real pointer events)', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 400, height: 300, background: 'white' });
  await kit(page);
  const box = await page.locator('.doc-frame:not([hidden]) canvas.view').boundingBox();
  // a long thin tip whose angle follows the barrel rotation, size the wheel, roundness the tilt
  const r = await page.evaluate(async ([bx, by]) => {
    const app = window.pigmentApp;
    const { setToolBrush, normalizeBrush } = window.__brush;
    app.tools.activate('brush');
    app.setColors({ foreground: '#000000' });
    app.tools.setOpt('brush', 'pressureSize', false);
    app.tools.setOpt('brush', 'smoothing', 0);
    const ctl = (type) => ({ type, fadeSteps: 25 });
    const canvas = document.querySelector('.doc-frame:not([hidden]) canvas.view');
    const v = app.view;
    const scr = (x, y) => {
      const p = v.toScreen(x, y);
      const rc = canvas.getBoundingClientRect();
      return { clientX: rc.left + p.x, clientY: rc.top + p.y };
    };
    const penStroke = (pts, extra) => {
      const o = { bubbles: true, cancelable: true, composed: true, pointerId: 1, pointerType: 'pen', isPrimary: true, pressure: 0.8, ...extra };
      canvas.dispatchEvent(new PointerEvent('pointerdown', { ...o, ...scr(...pts[0]), button: 0, buttons: 1 }));
      for (const p of pts.slice(1)) canvas.dispatchEvent(new PointerEvent('pointermove', { ...o, ...scr(...p), button: -1, buttons: 1 }));
      canvas.dispatchEvent(new PointerEvent('pointerup', { ...o, ...scr(...pts[pts.length - 1]), button: 0, buttons: 0 }));
    };
    const layer = app.doc.active;
    const a = (x, y) => 255 - layer.canvas.getContext('2d').getImageData(x - layer.x, y - layer.y, 1, 1).data[0];
    // one dab (a click) with a 40 x 4 tip turned by the barrel: twist 90 stands it up
    setToolBrush(app, 'brush', normalizeBrush({ tip: { size: 40, hardness: 1, roundness: 0.1 }, shapeDynamics: { enabled: true, angleControl: ctl('rotation') } }), { includeTool: false });
    penStroke([[100, 100]], { twist: 90 });
    const twist = { up: a(100, 115), side: a(115, 100) };
    // the wheel: -1 gives the minimum diameter (25 %), +1 the full size
    setToolBrush(app, 'brush', normalizeBrush({ tip: { size: 40, hardness: 1 }, shapeDynamics: { enabled: true, sizeControl: ctl('stylus-wheel'), minimumDiameter: 0.25 } }), { includeTool: false });
    penStroke([[200, 100]], { tangentialPressure: -1 });
    penStroke([[300, 100]], { tangentialPressure: 1 });
    const wheel = { small: [a(200, 100), a(212, 100)], big: [a(300, 100), a(312, 100)] };
    // the tilt: a pen leaning 60 deg with the size controlled by tilt and Tilt Scale 200 % squashes the tip
    setToolBrush(app, 'brush', normalizeBrush({ tip: { size: 40, hardness: 1 }, shapeDynamics: { enabled: true, sizeControl: ctl('pen-tilt'), tiltScale: 2, minimumDiameter: 1 } }), { includeTool: false });
    penStroke([[100, 220]], { tiltX: 0, tiltY: 0 });
    penStroke([[250, 220]], { tiltX: 0, tiltY: 60 });
    const tilt = { upright: [a(100, 236), a(116, 220)], leaning: [a(250, 236), a(266, 220)] };
    return { twist, wheel, tilt, entries: app.doc.history.entries.map((e) => e.label) };
  }, [box.x, box.y]);
  expect(r.twist.up).toBeGreaterThan(200);
  expect(r.twist.side).toBe(0);
  expect(r.wheel.small).toEqual([255, 0]);
  expect(r.wheel.big[0]).toBe(255);
  expect(r.wheel.big[1]).toBeGreaterThan(200);
  expect(r.tilt.upright.every((x) => x > 200)).toBe(true);
  // leaning: still wide, no longer tall
  expect(r.tilt.leaning[1]).toBeGreaterThan(200);
  expect(r.tilt.leaning[0]).toBe(0);
  // one entry per stroke
  expect(r.entries.filter((l) => l === 'Brush')).toHaveLength(5);
  expect(errors).toEqual([]);
});

test('Define Brush Preset: the selection\'s dark pixels become a sampled tip in "Defined", which paints its shape; replay by name', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 300, height: 200, background: 'white' });
  await kit(page);
  await page.evaluate(() => {
    const app = window.pigmentApp, l = app.doc.active;
    const g = l.canvas.getContext('2d');
    // a black 30 x 20 bar with a white hole
    g.fillStyle = '#000';
    g.fillRect(20, 20, 30, 20);
    g.fillStyle = '#fff';
    g.fillRect(30, 25, 10, 10);
    l.touch();
  });
  const sel = await page.evaluate(async () => {
    const app = window.pigmentApp;
    const { Selection } = await import('/lib/selection.js');
    app.applySelection(Selection.fromRect(app.doc.width, app.doc.height, { x: 10, y: 10, width: 60, height: 40 }), 'replace', 'Rectangular Marquee');
    return app.doc.selection.bounds;
  });
  expect(sel.width).toBe(60);
  const recorded = await page.evaluate(async () => {
    const app = window.pigmentApp;
    const done = new Promise((resolve) => {
      const off = app.on('command:done', (ev) => {
        if (ev.id !== 'edit:define-brush') return;
        off?.();
        resolve(ev.arg);
      });
    });
    const preset = await app.commands.run('edit:define-brush', { name: 'Bar' }, 'api');
    const arg = await done;
    await new Promise((r) => setTimeout(r, 0));
    const group = app.presets.groups('brushes').find((g) => g.id === preset.group);
    const blob = await app.presets.readBlob('brushes', preset.data.tip.sample.blob);
    const { toolBrush } = window.__brush;
    return { arg, name: preset.name, group: group?.name, tip: preset.data.tip, blob: blob?.length ?? 0, tool: toolBrush(app, 'brush').preset.tip, presetId: app.settings.tools.brush.brushPresetId === preset.id };
  });
  expect(recorded.arg).toEqual({ name: 'Bar' });
  expect(recorded.name).toBe('Bar');
  expect(recorded.group).toBe('Defined');
  expect(recorded.tip).toMatchObject({ kind: 'sampled', size: 30, spacing: 0.25, sample: { width: 30, height: 20 } });
  expect(recorded.tip.sample.blob).toMatch(/^tip-[0-9a-f]{40}\.png$/);
  expect(recorded.blob).toBeGreaterThan(0);
  expect(recorded.tool.kind).toBe('sampled');
  expect(recorded.presetId).toBe(true);
  // the tip paints its shape: a click on a new layer gives the bar with its hole
  const shape = await page.evaluate(async () => {
    const app = window.pigmentApp;
    app.applySelection(null, 'replace', 'Deselect');
    await app.commands.run('layer:new', { name: 'Tip' }, 'api');
    app.setColors({ foreground: '#0000ff' });
    window.__paint('brush', null, [{ x: 150, y: 100 }], { opacity: 1, flow: 1, smoothing: 0, pressureSize: false });
    const a = window.__alpha;
    return { bar: a(138, 92), hole: a(150, 100), outside: a(150, 115), wide: a(162, 108) };
  });
  expect(shape.bar).toBeGreaterThan(200);
  expect(shape.wide).toBeGreaterThan(200);
  expect(shape.hole).toBeLessThan(30);
  expect(shape.outside).toBe(0);
  // a replay defines the same brush again by name, without asking (no dialog opens)
  const again = await page.evaluate(async () => {
    const app = window.pigmentApp;
    app.doc.setActive(app.doc.root.children[0]);
    const p = await app.commands.run('edit:define-brush', { name: 'Bar again' }, 'action');
    return { name: p?.name, dialogs: document.querySelectorAll('.dialog-backdrop').length, same: p?.data.tip.sample.blob };
  });
  expect(again.name).toBe('Bar again');
  expect(again.dialogs).toBe(0);
  // nothing dark: a message, no preset
  const none = await page.evaluate(async () => {
    const app = window.pigmentApp;
    await app.commands.run('layer:new', { name: 'Empty' }, 'api');
    const n = app.presets.list('brushes').length;
    const { Selection } = await import('/lib/selection.js');
    app.applySelection(Selection.fromRect(app.doc.width, app.doc.height, { x: 200, y: 150, width: 40, height: 40 }), 'replace', 'Rectangular Marquee');
    const p = await app.commands.run('edit:define-brush', { name: 'Nothing' }, 'api');
    return { p: p ?? null, added: app.presets.list('brushes').length - n };
  });
  expect(none).toEqual({ p: null, added: 0 });
  expect(errors).toEqual([]);
});

test('Behind paints only under transparency, Clear paints transparency, Dissolve is all or nothing; locked transparency stops both', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 300, height: 200, background: 'transparent' });
  await kit(page);
  const r = await page.evaluate(() => {
    const app = window.pigmentApp, l = app.doc.active;
    l.ensureCovers({ x: 0, y: 0, width: 300, height: 200 });
    const g = l.canvas.getContext('2d');
    g.fillStyle = '#ff0000';
    g.fillRect(100 - l.x, 0 - l.y, 100, 200);
    l.touch();
    app.setColors({ foreground: '#0000ff' });
    const opts = { opacity: 1, flow: 1, smoothing: 0, pressureSize: false, hardness: 1, size: 20 };
    const line = (y) => [{ x: 20, y }, { x: 150, y }, { x: 280, y }];
    const out = {};
    out.behindEntries = window.__paint('brush', null, line(40), { ...opts, blend: 'behind' });
    out.behind = { onRed: window.__rgba(150, 40), onEmpty: window.__rgba(50, 40) };
    window.__paint('brush', null, line(90), { ...opts, blend: 'clear' });
    out.clear = { onRed: window.__rgba(150, 90), empty: window.__rgba(50, 90) };
    // Dissolve at 50 % opacity: every touched pixel is either untouched red or fully blue
    window.__paint('brush', null, line(140), { ...opts, size: 30, opacity: 0.5, blend: 'dissolve' });
    const d = l.canvas.getContext('2d').getImageData(110 - l.x, 130 - l.y, 80, 20).data;
    let blue = 0, red = 0, other = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] === 0 && d[i + 2] === 255 && d[i + 3] === 255) blue++;
      else if (d[i] === 255 && d[i + 2] === 0 && d[i + 3] === 255) red++;
      else other++;
    }
    out.dissolve = { blue, red, other };
    // the Mode menu offers them
    out.modes = [...document.querySelectorAll('#options-bar .opt[data-key="blend"] option')].map((o) => o.value).slice(0, 4);
    // locked transparency: neither Behind nor Clear changes a pixel
    l.locked.transparency = true;
    window.__paint('brush', null, line(180), { ...opts, blend: 'clear' });
    window.__paint('brush', null, line(180), { ...opts, blend: 'behind' });
    out.locked = { onRed: window.__rgba(150, 180), empty: window.__rgba(50, 180) };
    l.locked.transparency = false;
    // undo takes the Clear stroke back
    return out;
  });
  expect(r.behindEntries).toEqual(['Brush']);
  expect(r.behind.onRed).toEqual([255, 0, 0, 255]);
  expect(r.behind.onEmpty).toEqual([0, 0, 255, 255]);
  expect(r.clear.onRed[3]).toBe(0);
  expect(r.clear.empty[3]).toBe(0);
  expect(r.dissolve.other).toBe(0);
  expect(r.dissolve.blue).toBeGreaterThan(100);
  expect(r.dissolve.red).toBeGreaterThan(100);
  expect(r.modes).toEqual(['normal', 'dissolve', 'behind', 'clear']);
  expect(r.locked).toEqual({ onRed: [255, 0, 0, 255], empty: [0, 0, 0, 0] });
  // the Clear stroke undoes and redoes as one entry
  const u = await page.evaluate(async () => {
    const app = window.pigmentApp;
    const labels = app.doc.history.entries.slice(0, app.doc.history.index + 1).map((e) => e.label);
    // undo the two locked strokes, the dissolve and the clear
    for (let i = 0; i < 4; i++) app.doc.history.undo();
    const undone = window.__rgba(150, 90);
    app.doc.history.redo();
    return { labels, undone, redone: window.__rgba(150, 90) };
  });
  expect(u.undone).toEqual([255, 0, 0, 255]);
  expect(u.redone[3]).toBe(0);
  expect(errors).toEqual([]);
});

test('Transfer: the opacity ceiling caps a stroke\'s build-up, by pen pressure', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 300, height: 120, background: 'transparent' });
  await kit(page);
  const r = await page.evaluate(() => {
    const app = window.pigmentApp;
    app.setColors({ foreground: '#000000' });
    const opts = { opacity: 1, flow: 1, smoothing: 0, pressureSize: false, pressureOpacity: false };
    const ctl = (type) => ({ type, fadeSteps: 25 });
    // opacity by pen pressure, minimum 0: a half-pressure stroke never passes 50 % however many dabs overlap
    const back = [];
    for (let i = 0; i < 6; i++) back.push({ x: 40 + (i % 2) * 4, y: 40, pressure: 0.5 }, { x: 260 - (i % 2) * 4, y: 40, pressure: 0.5 });
    window.__paint('brush', { tip: { size: 30, hardness: 1, spacing: 0.05 }, transfer: { enabled: true, opacityControl: ctl('pen-pressure') } }, back, opts);
    const capped = window.__alpha(150, 40);
    // the same stroke at full pressure reaches full alpha
    window.__paint('brush', { tip: { size: 30, hardness: 1, spacing: 0.05 }, transfer: { enabled: true, opacityControl: ctl('pen-pressure') } }, back.map((p) => ({ ...p, y: 90, pressure: 1 })), opts);
    return { capped, full: window.__alpha(150, 90) };
  });
  expect(Math.abs(r.capped - 128)).toBeLessThanOrEqual(2);
  expect(r.full).toBe(255);
  expect(errors).toEqual([]);
});

test('a 16-bit stroke keeps the deep pixels in step; Grayscale stays grey and Indexed snaps under Color Dynamics', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 200, height: 120, background: 'white', depth: 16 });
  await kit(page);
  const deep = await page.evaluate(() => {
    const app = window.pigmentApp;
    app.setColors({ foreground: '#ff0000' });
    window.__paint('brush', { tip: { size: 20, hardness: 1 }, shapeDynamics: { enabled: true, sizeJitter: 0.5 }, scattering: { enabled: true, scatter: 0.5 } }, [{ x: 20, y: 60 }, { x: 180, y: 60 }], { smoothing: 0, pressureSize: false });
    const l = app.doc.active;
    app.deep.sync(app.doc);
    const img = l.canvas.getContext('2d').getImageData(0, 0, l.canvas.width, l.canvas.height).data;
    const d = l.deep.data;
    let mismatches = 0;
    for (let i = 0; i < d.length; i += 4) if (img[i + 3] === 255 && Math.floor((d[i] + 128) / 257) !== img[i]) mismatches++;
    const o = (60 * l.canvas.width + 100) * 4;
    return { type: l.deep.type, mismatches, at: Array.from(d.subarray(o, o + 4)) };
  });
  expect(deep.type).toBe('u16');
  expect(deep.mismatches).toBe(0);
  expect(deep.at).toEqual([65535, 0, 0, 65535]);

  await newDoc(page, { width: 200, height: 120, background: 'white' });
  await runAwait(page, 'image:mode', { mode: 'grayscale', silent: true, flatten: true });
  await kit(page);
  const grey = await page.evaluate(() => {
    const app = window.pigmentApp;
    app.setColors({ foreground: '#808080', background: '#000000' });
    window.__paint('brush', { tip: { size: 16, hardness: 1 }, colorDynamics: { enabled: true, hueJitter: 1, saturationJitter: 1, fbJitter: 0.5 } }, [{ x: 20, y: 60 }, { x: 180, y: 60 }], { smoothing: 0, pressureSize: false });
    const l = app.doc.active;
    const d = l.canvas.getContext('2d').getImageData(0, 0, l.canvas.width, l.canvas.height).data;
    let coloured = 0, painted = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] !== 255) painted++;
      if (d[i] !== d[i + 1] || d[i + 1] !== d[i + 2]) coloured++;
    }
    return { coloured, painted };
  });
  expect(grey.painted).toBeGreaterThan(500);
  expect(grey.coloured).toBe(0);

  await newDoc(page, { width: 200, height: 120, background: 'white' });
  await page.evaluate(() => {
    const l = window.pigmentApp.doc.active;
    const g = l.canvas.getContext('2d');
    const colours = ['#ff0000', '#00ff00', '#0000ff', '#ffff00', '#000000', '#ffffff', '#ff00ff', '#00ffff'];
    colours.forEach((c, i) => {
      g.fillStyle = c;
      g.fillRect(i * 25, 0, 25, 120);
    });
    l.touch();
  });
  await runAwait(page, 'image:mode', { mode: 'indexed', silent: true, flatten: true, options: { palette: 'adaptive', colors: 8, forced: 'none', transparency: true, matte: null, dither: 'none', ditherAmount: 0, preserveExactColors: false } });
  await expect.poll(() => page.evaluate(() => window.pigmentApp.doc.mode)).toBe('indexed');
  await kit(page);
  const indexed = await page.evaluate(() => {
    const app = window.pigmentApp;
    app.setColors({ foreground: '#ff0000', background: '#0000ff' });
    // the Pencil: whole, opaque pixels, so every painted pixel is a dab's colour
    window.__paint('pencil', { tip: { size: 12 }, colorDynamics: { enabled: true, hueJitter: 1, fbJitter: 1 } }, [{ x: 10, y: 60 }, { x: 190, y: 60 }], { opacity: 1 });
    const l = app.doc.active;
    const d = l.canvas.getContext('2d').getImageData(0, 54, 200, 12).data;
    const hex = (i) => `#${[d[i], d[i + 1], d[i + 2]].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
    let off = 0;
    for (let i = 0; i < d.length; i += 4) if (app.colorConstraint(hex(i), app.doc) !== hex(i)) off++;
    return { off };
  });
  expect(indexed.off).toBe(0);
  expect(errors).toEqual([]);
});

test('scattered dabs grow a lazily grown layer around the path; one entry that undoes and redoes; .pigment keeps the pixels', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 600, height: 400, background: 'white' });
  await kit(page);
  const r = await page.evaluate(async () => {
    const app = window.pigmentApp;
    await app.commands.run('layer:new', { name: 'Scatter' }, 'api');
    const l = app.doc.active;
    const before = { x: l.x, y: l.y, w: l.canvas.width, h: l.canvas.height };
    app.setColors({ foreground: '#000000' });
    const entries = window.__paint('brush', { tip: { size: 20, hardness: 1, spacing: 0.5 }, scattering: { enabled: true, scatter: 5, count: 4 } }, [{ x: 280, y: 200 }, { x: 320, y: 200 }], { smoothing: 0, pressureSize: false });
    const after = { x: l.x, y: l.y, w: l.canvas.width, h: l.canvas.height };
    const d = l.canvas.getContext('2d').getImageData(0, 0, l.canvas.width, l.canvas.height).data;
    let far = 0;
    for (let y = 0; y < l.canvas.height; y++) for (let x = 0; x < l.canvas.width; x++) if (d[(y * l.canvas.width + x) * 4 + 3] > 0 && Math.abs(y + l.y - 200) > 40) far++;
    const h = app.doc.history;
    h.undo();
    const undone = (() => {
      const dd = l.canvas.getContext('2d').getImageData(0, 0, l.canvas.width, l.canvas.height).data;
      for (let i = 3; i < dd.length; i += 4) if (dd[i]) return false;
      return true;
    })();
    h.redo();
    return { before, after, entries, far, undone };
  });
  expect(r.entries).toEqual(['Brush']);
  // the layer grew by the reach (the tip plus scatter x diameter = 120 px) around the path
  expect(r.after.y).toBeLessThanOrEqual(200 - 110);
  expect(r.after.y + r.after.h).toBeGreaterThanOrEqual(200 + 110);
  expect(r.far).toBeGreaterThan(0);
  expect(r.undone).toBe(true);
  // save and reopen as .pigment: the scattered pixels come back
  const before = await page.evaluate(() => {
    const l = window.pigmentApp.doc.active;
    window.__pigmentTest.nextSavePath = 'mem:/scatter.pigment';
    return { x: l.x, y: l.y, data: Array.from(l.canvas.getContext('2d').getImageData(0, 0, l.canvas.width, l.canvas.height).data.filter((_, i) => i % 4 === 3)).reduce((a, b) => a + b, 0) };
  });
  await runAwait(page, 'file:save-as');
  await expect.poll(() => page.evaluate(() => !!window.__pigmentTest.written['mem:/scatter.pigment'])).toBe(true);
  await page.evaluate(() => (window.__pigmentTest.files['mem:/reopen.pigment'] = window.__pigmentTest.written['mem:/scatter.pigment']));
  await runAwait(page, 'file:open-paths', ['mem:/reopen.pigment']);
  await expect.poll(() => page.evaluate(() => window.pigmentApp.doc.path)).toBe('mem:/reopen.pigment');
  const reopened = await page.evaluate(() => {
    const l = window.pigmentApp.doc.layers().find((x) => x.name === 'Scatter');
    return { x: l.x, y: l.y, data: Array.from(l.canvas.getContext('2d').getImageData(0, 0, l.canvas.width, l.canvas.height).data.filter((_, i) => i % 4 === 3)).reduce((a, b) => a + b, 0) };
  });
  expect(reopened.data).toBe(before.data);
  expect(errors).toEqual([]);
});

test('airbrush: the button and Shift+Alt+P toggle Build-up; a resting pointer builds paint up; one entry', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 300, height: 200, background: 'transparent' });
  await kit(page);
  await page.evaluate(() => {
    const app = window.pigmentApp;
    app.tools.activate('brush');
    app.setColors({ foreground: '#000000' });
    for (const [k, v] of Object.entries({ size: 30, hardness: 1, flow: 0.1, opacity: 1, smoothing: 0, pressureSize: false })) app.tools.setOpt('brush', k, v);
  });
  const button = page.locator('#options-bar .opt[data-key="airbrush"] button');
  await expect(button).toHaveAttribute('aria-pressed', 'false');
  await button.click();
  await expect(button).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => window.__brush.toolBrush(window.pigmentApp, 'brush').preset.buildUp)).toBe(true);
  // the Pencil has no airbrush; Shift+Alt+P runs nothing there
  await page.evaluate(() => window.pigmentApp.tools.activate('pencil'));
  await expect(page.locator('#options-bar .opt[data-key="airbrush"]')).toHaveCount(0);
  expect(await page.evaluate(() => window.pigmentApp.commands.isEnabled('tool:airbrush-toggle'))).toBe(false);
  await page.evaluate(() => window.pigmentApp.tools.activate('brush'));
  // a press held still for 400 ms: the dabs keep coming (flow 10 % each) and darken the spot
  const held = await page.evaluate(async () => {
    const app = window.pigmentApp, tool = app.tools.get('brush');
    const before = app.doc.history.index;
    const p = { x: 100, y: 100, pressure: 1, button: 0, buttons: 1 };
    tool.onPointerDown(p);
    await new Promise((r) => setTimeout(r, 400));
    tool.onPointerUp(p);
    const a = window.__alpha(100, 100);
    // a click without build-up: one dab at flow 10 %
    return { a, entries: app.doc.history.index - before };
  });
  expect(held.entries).toBe(1);
  expect(held.a).toBeGreaterThan(150);
  // Shift+Alt+P turns it off again (a paint key)
  await page.evaluate(() => document.activeElement?.blur?.());
  await page.locator('.doc-frame:not([hidden]) canvas.view').hover();
  await page.keyboard.press('Shift+Alt+P');
  await expect(button).toHaveAttribute('aria-pressed', 'false');
  const click = await page.evaluate(async () => {
    const app = window.pigmentApp, tool = app.tools.get('brush');
    const p = { x: 200, y: 100, pressure: 1, button: 0, buttons: 1 };
    tool.onPointerDown(p);
    await new Promise((r) => setTimeout(r, 300));
    tool.onPointerUp(p);
    return window.__alpha(200, 100);
  });
  expect(click).toBeLessThan(40);
  expect(errors).toEqual([]);
});

test('smoothing options: the popover writes the tool\'s smoothingOptions; Pulled String shows a leash while painting', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 400, height: 200, background: 'white' });
  await kit(page);
  await page.evaluate(() => {
    const app = window.pigmentApp;
    app.tools.activate('brush');
    app.tools.setOpt('brush', 'smoothing', 0.5);
  });
  await page.locator('#options-bar .opt[data-key="smoothingOptions"] button').click();
  await page.locator('.popover .popover-item', { hasText: 'Pulled String Mode' }).click();
  const r = await page.evaluate(() => {
    const app = window.pigmentApp, tool = app.tools.get('brush');
    const opts = app.settings.tools.brush.smoothingOptions;
    const p = { x: 50, y: 100, pressure: 1, button: 0, buttons: 1 };
    tool.onPointerDown(p);
    tool.onPointerMove({ ...p, x: 300 }, true);
    const leash = tool.stroke?.leash ?? null;
    tool.onPointerUp({ ...p, x: 300 });
    const l = app.doc.active;
    const dark = (x) => l.canvas.getContext('2d').getImageData(x, 100, 1, 1).data[0] < 128;
    return { opts, leash, painted: dark(150), released: dark(299) };
  });
  expect(r.opts.mode).toBe('pulled-string');
  expect(r.leash).not.toBeNull();
  expect(r.leash.to.x).toBe(300);
  expect(r.leash.from.x).toBeLessThan(300);
  expect(r.painted).toBe(true);
  // without Catch-up on Stroke End the stroke stops a leash short of the release
  expect(r.released).toBe(false);
  expect(errors).toEqual([]);
});
