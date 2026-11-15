// brush-painting-behaviours (ARCHITECTURE.md "0.5 features", package 3): the pure parts of the paint gestures (which
// presses the HUDs claim on each platform, the Shift axis lock, the HUD's values, Shift-click lines, the tilde, the pen's
// eraser end), the paint keys (digit pairs, which option a digit or a mode key sets, preset steps), the cursor (Normal
// Brush Tip's scale, the cursor filter) and the Cursors preferences.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PaintGesture, pressGesture, AxisLock, hudValues, paintKeyState, HUD_VERTICAL_SPAN } from '../../src/renderer/lib/tools/paint-gesture.js';
import { DigitPair, digitOption, digitValue, blendTarget, stepPreset, cursorsPreferences, PAINT_KEY_COMMANDS, PAINT_BLEND_MODES } from '../../src/renderer/lib/tools/paint-keys.js';
import { normalTipScale, cursorPolygons, cursorFilter, paintingCursorStyle, effectiveCursorStyle } from '../../src/renderer/lib/brush-cursor.js';
import { hudLabel } from '../../src/renderer/lib/brush-hud.js';
import { PAINT_KEYS } from '../../src/shared/keymap.js';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults.js';

const slider = (key, min = 0.01, max = 1, extra = {}) => ({ kind: 'slider', key, min, max, step: 0.01, default: 1, ...extra });
const select = (key, values) => ({ kind: 'select', key, options: values.map((v) => [v, v]), default: values[0] });

test('the package has landed (S15), and its commands are the S13.3 PAINT keys', () => {
  assert.equal(PaintGesture.real, true);
  const paintIds = Object.keys(PAINT_KEYS).filter((id) => id !== 'tool:airbrush-toggle').sort();
  assert.deepEqual([...PAINT_KEY_COMMANDS].sort(), paintIds);
  assert.equal(PAINT_BLEND_MODES.length, 25);
  assert.ok(PAINT_BLEND_MODES.includes('behind') && PAINT_BLEND_MODES.includes('clear') && !PAINT_BLEND_MODES.includes('pass-through'));
});

test('claims per platform: Alt+right-drag and Alt+Shift+right-drag on Windows and Linux; Ctrl+Alt(+Cmd)-drag on macOS', () => {
  const win = { mac: false }, mac = { mac: true };
  assert.equal(pressGesture({ button: 2, alt: true }, win), 'resize');
  assert.equal(pressGesture({ button: 2, alt: true, shift: true }, win), 'color');
  assert.equal(pressGesture({ button: 2 }, win), null);
  assert.equal(pressGesture({ button: 0, alt: true }, win), null);
  assert.equal(pressGesture({ button: 2, alt: true, ctrl: true }, win), null);
  assert.equal(pressGesture({ button: 0, ctrl: true, alt: true }, win), null);
  assert.equal(pressGesture({ button: 0, ctrl: true, alt: true }, mac), 'resize');
  assert.equal(pressGesture({ button: 0, ctrl: true, alt: true, meta: true }, mac), 'color');
  assert.equal(pressGesture({ button: 0, ctrl: true }, mac), null);
  assert.equal(pressGesture({ button: 2, alt: true }, mac), null);
  // the gesture's claims follow PaintGesture.mac
  const g = new PaintGesture(fakeTool().tool);
  const was = PaintGesture.mac;
  try {
    PaintGesture.mac = false;
    assert.equal(g.claims({ button: 2, alt: true }), true);
    assert.equal(g.claims({ button: 0, ctrl: true, alt: true }), false);
    assert.equal(g.claims({ button: 0, alt: true }), false); // a plain Alt-click stays the Eyedropper's
    PaintGesture.mac = true;
    assert.equal(g.claims({ button: 0, ctrl: true, alt: true }), true);
    assert.equal(g.claims({ button: 2, alt: true }), false);
  } finally {
    PaintGesture.mac = was;
  }
});

test('axis lock: the anchor until the threshold, then the axis moved along most', () => {
  const lock = new AxisLock({ x: 100, y: 100 }, { threshold: 4 });
  assert.deepEqual(lock.apply({ x: 102, y: 101, pressure: 0.5 }), { x: 100, y: 100, pressure: 0.5 });
  assert.equal(lock.axis, null);
  assert.deepEqual(lock.apply({ x: 110, y: 103 }), { x: 110, y: 100 });
  assert.equal(lock.axis, 'x');
  // once chosen the axis holds, however the pointer wanders
  assert.deepEqual(lock.apply({ x: 90, y: 160 }), { x: 90, y: 100 });
  const v = new AxisLock({ x: 0, y: 0 }, { threshold: 4 });
  assert.deepEqual(v.apply({ x: -3, y: -8 }), { x: 0, y: -8 });
  assert.equal(v.axis, 'y');
});

test('HUD values: right grows the diameter by twice the movement (screen px over zoom); up raises hardness or opacity', () => {
  assert.deepEqual(hudValues({ size: 50, hardness: 0.5 }, 20, 0), { size: 90, hardness: 0.5 });
  assert.deepEqual(hudValues({ size: 50, hardness: 0.5 }, 20, 0, { zoom: 2 }), { size: 70, hardness: 0.5 });
  assert.deepEqual(hudValues({ size: 50, hardness: 0.5 }, -100, 0), { size: 1, hardness: 0.5 });
  assert.deepEqual(hudValues({ size: 900, hardness: 0.5 }, 200, 0, { maxSize: 1000 }), { size: 1000, hardness: 0.5 });
  assert.deepEqual(hudValues({ size: 50, hardness: 0.5 }, 0, -HUD_VERTICAL_SPAN / 4), { size: 50, hardness: 0.75 });
  assert.deepEqual(hudValues({ size: 50, hardness: 0.5 }, 0, HUD_VERTICAL_SPAN), { size: 50, hardness: 0 });
  assert.deepEqual(hudValues({ size: 50, opacity: 1 }, 0, HUD_VERTICAL_SPAN * 2, { vertical: 'opacity' }), { size: 50, opacity: 0.01 });
  // a tool without the vertical option (the Pencil has no hardness): size only
  assert.deepEqual(hudValues({ size: 50 }, 10, -50), { size: 70 });
  assert.equal(hudLabel({ size: 70.4, hardness: 0.756 }), 'Size 70 px · Hardness 76 %');
  assert.equal(hudLabel({ size: 70, opacity: 0.5 }, 'opacity'), 'Size 70 px · Opacity 50 %');
});

test('digit pairs: one digit 10 %…100 %, two within the window the exact value, a third starts afresh', () => {
  const d = new DigitPair(600);
  assert.equal(d.press('brush|opacity', '5', 0).percent, 50);
  assert.deepEqual(d.press('brush|opacity', '5', 100), { percent: 55, paired: true });
  assert.deepEqual(d.press('brush|opacity', '3', 150), { percent: 30, paired: false }); // after a pair: afresh
  assert.equal(d.press('brush|opacity', '0', 900).percent, 100); // 750 ms later: a single digit
  assert.equal(d.press('brush|opacity', '0', 1000).percent, 0); // 0 then 0
  assert.equal(d.press('brush|opacity', '0', 2000).percent, 100);
  assert.equal(d.press('brush|opacity', '5', 2100).percent, 5); // 0 then 5
  // another key (flow, or another tool) never pairs with the last digit
  d.press('brush|opacity', '4', 3000);
  assert.equal(d.press('brush|flow', '5', 3100).percent, 50);
  assert.equal(d.press('pencil|opacity', '7', 3150).percent, 70);
  // the window is the setting's
  assert.equal(d.press('brush|opacity', '2', 5000, 100).percent, 20);
  assert.equal(d.press('brush|opacity', '2', 5200, 100).percent, 20);
  // values: fractions of 0..1 sliders, clamped to the option (0 % is the least the slider takes)
  assert.equal(digitValue(slider('opacity'), 45), 0.45);
  assert.equal(digitValue(slider('opacity'), 0), 0.01);
  assert.equal(digitValue(slider('opacity', 0, 1), 0), 0);
  assert.equal(digitValue(slider('strength', 1, 100), 30), 30);
});

test('which option a digit sets: opacity, else Strength / Exposure / the Sponge\'s Flow; Shift: flow; the airbrush swaps them', () => {
  const brush = { id: 'brush', options: [slider('size', 1, 5000), slider('opacity'), slider('flow')] };
  assert.equal(digitOption(brush, 'opacity').key, 'opacity');
  assert.equal(digitOption(brush, 'flow').key, 'flow');
  assert.equal(digitOption(brush, 'opacity', { airbrush: true }).key, 'flow');
  assert.equal(digitOption(brush, 'flow', { airbrush: true }).key, 'opacity');
  const pencil = { id: 'pencil', options: [slider('size', 1, 5000), slider('opacity')] };
  assert.equal(digitOption(pencil, 'flow'), null);
  assert.equal(digitOption({ id: 'blur', options: [slider('strength')] }, 'opacity').key, 'strength');
  assert.equal(digitOption({ id: 'dodge', options: [slider('exposure')] }, 'opacity').key, 'exposure');
  assert.equal(digitOption({ id: 'sponge', options: [slider('flow')] }, 'opacity').key, 'flow');
  // an option the bar hides now (the Gradient tool's opacity in Gradient mode) does not take the digit
  const gradient = { id: 'gradient', m: 'gradient', mode() { return this.m; }, options: [slider('opacity', 0.01, 1, { when: (t) => t.mode() === 'classic' })] };
  assert.equal(digitOption(gradient, 'opacity'), null);
  gradient.m = 'classic';
  assert.equal(digitOption(gradient, 'opacity').key, 'opacity');
});

test('which option a mode key sets: the painting mode, the Dodge and Burn range, the Sponge mode, Color Replacement', () => {
  const modes = ['normal', 'dissolve', 'behind', 'clear', 'multiply', 'screen'];
  const brush = { id: 'brush', options: [select('blend', modes)] };
  assert.deepEqual(blendTarget(brush, 'multiply'), { key: 'blend', value: 'multiply' });
  assert.deepEqual(blendTarget(brush, 'behind'), { key: 'blend', value: 'behind' });
  assert.equal(blendTarget(brush, 'hue'), null);
  const dodge = { id: 'dodge', options: [select('range', ['shadows', 'midtones', 'highlights'])] };
  assert.deepEqual(blendTarget(dodge, 'screen'), { key: 'range', value: 'shadows' });
  assert.deepEqual(blendTarget(dodge, 'multiply'), { key: 'range', value: 'midtones' });
  assert.deepEqual(blendTarget({ ...dodge, id: 'burn' }, 'hard-light'), { key: 'range', value: 'highlights' });
  assert.equal(blendTarget(dodge, 'normal'), null);
  const sponge = { id: 'sponge', options: [select('mode', ['desaturate', 'saturate'])] };
  assert.deepEqual(blendTarget(sponge, 'color-dodge'), { key: 'mode', value: 'desaturate' });
  assert.deepEqual(blendTarget(sponge, 'screen'), { key: 'mode', value: 'saturate' });
  const replace = { id: 'color-replace', options: [select('mode', ['color', 'hue', 'saturation', 'luminosity'])] };
  assert.deepEqual(blendTarget(replace, 'hue'), { key: 'mode', value: 'hue' });
  assert.equal(blendTarget({ id: 'eraser', options: [select('mode', ['brush', 'pencil', 'block'])] }, 'multiply'), null);
});

test('preset steps wrap; from no preset, next is the first and previous the last', () => {
  const ids = ['a', 'b', 'c'];
  assert.equal(stepPreset(ids, 'b', 'next'), 'c');
  assert.equal(stepPreset(ids, 'c', 'next'), 'a');
  assert.equal(stepPreset(ids, 'a', 'prev'), 'c');
  assert.equal(stepPreset(ids, null, 'next'), 'a');
  assert.equal(stepPreset(ids, 'gone', 'prev'), 'c');
  assert.equal(stepPreset(ids, 'b', 'first'), 'a');
  assert.equal(stepPreset(ids, 'b', 'last'), 'c');
  assert.equal(stepPreset([], 'b', 'next'), null);
});

/** A tool shaped like a StrokeTool, recording what the gesture asks of it. */
function fakeTool(id = 'brush', { options, tools = {} } = {}) {
  const log = [];
  const stored = {};
  const doc = { name: 'doc' };
  const app = {
    settings: { foreground: '#123456', painting: DEFAULT_SETTINGS.painting },
    tools: { get: (t) => tools[t] ?? null },
    colorPicker: null,
  };
  const tool = {
    id,
    app,
    doc,
    view: { zoom: 1, invalidate() {} },
    options: options ?? [slider('size', 1, 5000, { default: 20 }), slider('hardness', 0, 1, { default: 0.5 }), slider('opacity')],
    opt(k) {
      return k in stored ? stored[k] : this.options.find((o) => o.key === k)?.default;
    },
    setOpt(k, v) {
      stored[k] = v;
      log.push(['set', k, v]);
    },
    strokeDown(p, opts) {
      log.push(['down', p.x, p.y, opts?.erase ? 'erase' : '']);
      this.stroke = { s: { smoothing: 0.5 } };
    },
    strokeMove(p, dragging) {
      log.push(['move', p.x, p.y, dragging]);
    },
    strokeUp(p) {
      log.push(['up', p?.x, p?.y]);
      this.stroke = null;
    },
  };
  return { tool, log, stored, app };
}

test('Shift-click draws one stroke from the last end point; Shift-drag holds the axis; smoothing is off on the line', () => {
  const { tool, log } = fakeTool();
  const g = new PaintGesture(tool);
  g.down({ x: 10, y: 10, button: 0 });
  g.move({ x: 20, y: 12, button: 0 }, true);
  g.up({ x: 30, y: 15, button: 0 });
  assert.deepEqual(g.lastPoint(), { x: 30, y: 15 });
  log.length = 0;
  // Shift-click: the stroke starts at the last end point and goes to the click, one down and one up
  g.down({ x: 100, y: 80, button: 0, shift: true });
  assert.equal(tool.stroke.s.smoothing, 0);
  g.up({ x: 100, y: 80, button: 0, shift: true });
  assert.deepEqual(log, [['down', 30, 15, ''], ['move', 100, 80, true], ['up', 100, 80]]);
  assert.deepEqual(g.lastPoint(), { x: 100, y: 80 });
  // the end point is the document's: another document has none
  assert.equal(g.lastPoint({}), null);
  // Shift-drag without a last point (a new document): the drag keeps to its first direction
  log.length = 0;
  tool.doc = { name: 'other' };
  g.down({ x: 0, y: 0, button: 0, shift: true });
  g.move({ x: 2, y: 1, shift: true }, true);
  g.move({ x: 20, y: 6, shift: true }, true);
  g.move({ x: 40, y: 30, shift: true }, true);
  g.up({ x: 50, y: 40, shift: true });
  assert.deepEqual(log, [['down', 0, 0, ''], ['move', 0, 0, true], ['move', 20, 0, true], ['move', 40, 0, true], ['up', 50, 0]]);
  // Shift pressed mid-stroke holds the stroke from where it reached; released, it follows the pointer again
  log.length = 0;
  g.down({ x: 0, y: 0, button: 0 });
  g.move({ x: 10, y: 10 }, true);
  g.move({ x: 30, y: 12, shift: true }, true);
  g.move({ x: 40, y: 30 }, true);
  g.up({ x: 40, y: 30 });
  assert.deepEqual(log.map((e) => e.slice(0, 3)), [['down', 0, 0], ['move', 10, 10], ['move', 30, 10], ['move', 40, 30], ['up', 40, 30]]);
  // an Alt-click (sampling) leaves the last end point where it was
  g.down({ x: 5, y: 5, button: 0, alt: true });
  g.up({ x: 5, y: 5, alt: true });
  assert.deepEqual(g.lastPoint(), { x: 40, y: 30 });
});

test('the held tilde erases with the tool\'s brush; the pen\'s eraser end strokes with the Eraser tool', () => {
  const eraser = fakeTool('eraser');
  const { tool, log } = fakeTool('brush', { tools: { eraser: eraser.tool } });
  tool.tildeErases = true;
  const g = new PaintGesture(tool);
  try {
    paintKeyState.tilde = true;
    g.down({ x: 1, y: 1, button: 0 });
    g.up({ x: 1, y: 1 });
    assert.deepEqual(log[0], ['down', 1, 1, 'erase']);
    // a tool without tildeErases (the DabTools, the stamps) ignores it
    const dab = fakeTool('blur');
    new PaintGesture(dab.tool).down({ x: 1, y: 1, button: 0 });
    assert.deepEqual(dab.log[0], ['down', 1, 1, '']);
  } finally {
    paintKeyState.tilde = false;
  }
  log.length = 0;
  g.down({ x: 5, y: 5, button: 5, eraser: true, pointerType: 'pen' });
  g.move({ x: 9, y: 5, eraser: true }, true);
  g.up({ x: 9, y: 5, eraser: true });
  assert.deepEqual(log, []);
  assert.deepEqual(eraser.log, [['down', 5, 5, ''], ['move', 9, 5, true], ['up', 9, 5]]);
  // back on the tool's own stroke after the release
  g.down({ x: 1, y: 1, button: 0 });
  assert.deepEqual(log[0], ['down', 1, 1, '']);
});

test('the resize HUD writes size and hardness as it moves, Escape restores them; the colour HUD forwards to its session', async () => {
  const { tool, log, stored, app } = fakeTool();
  const g = new PaintGesture(tool);
  assert.equal(g.contextDown({ button: 2, alt: false }), false);
  assert.equal(g.contextDown({ button: 2, alt: true, x: 50, y: 50, screenX: 100, screenY: 100 }), true);
  g.move({ button: -1, buttons: 2, screenX: 110, screenY: 50 }, true);
  assert.equal(stored.size, 40);
  assert.equal(stored.hardness, 0.75);
  assert.ok(!log.some((e) => e[0] === 'down' || e[0] === 'move'), 'no stroke');
  assert.equal(g.key({ key: 'Escape' }), true);
  assert.equal(stored.size, 20);
  assert.equal(stored.hardness, 0.5);
  assert.equal(g.hud, null);
  // released: the values stay
  g.contextDown({ button: 2, alt: true, screenX: 0, screenY: 0 });
  g.move({ screenX: 15, screenY: 0 }, true);
  g.up({ screenX: 15, screenY: 0, button: 2 });
  assert.equal(stored.size, 50);
  assert.equal(g.hud, null);
  // vertical drag set to opacity (settings.painting.hud.vertical)
  app.settings.painting = { ...DEFAULT_SETTINGS.painting, hud: { vertical: 'opacity' } };
  g.contextDown({ button: 2, alt: true, screenX: 0, screenY: 0 });
  g.move({ screenX: 0, screenY: 100 }, true);
  g.up({ screenX: 0, screenY: 100, button: 2 });
  assert.equal(stored.opacity, 0.5);
  // the colour HUD: the picker's session gets every move and the release; Escape cancels it
  const calls = [];
  let resolve;
  app.colorPicker = {
    hud: (o) => {
      calls.push(['open', o.initial, o.at]);
      return { move: (p) => calls.push(['move', p.screenX]), up: (p) => { calls.push(['up', p.screenX]); resolve(null); }, cancel: () => { calls.push(['cancel']); resolve(null); }, done: new Promise((r) => (resolve = r)) };
    },
  };
  g.contextDown({ button: 2, alt: true, shift: true, screenX: 3, screenY: 4, original: { clientX: 13, clientY: 14 } });
  g.move({ screenX: 6 }, true);
  g.up({ screenX: 7, button: 2 });
  assert.deepEqual(calls, [['open', '#123456', { x: 13, y: 14 }], ['move', 6], ['up', 7]]);
  calls.length = 0;
  g.contextDown({ button: 2, alt: true, shift: true, screenX: 3, screenY: 4 });
  assert.equal(g.cancel(), true);
  assert.deepEqual(calls.map((c) => c[0]), ['open', 'cancel']);
  // without a picker (or the stub's session resolving null) nothing breaks
  app.colorPicker = null;
  assert.equal(g.contextDown({ button: 2, alt: true, shift: true }), true);
  g.move({ screenX: 1 }, true);
  g.up({ screenX: 1, button: 2 });
  assert.equal(g.hud, null);
});

test('cursor: Normal Brush Tip is the half-strength outline of a soft round tip; sampled tips keep their contour', () => {
  assert.equal(normalTipScale({ kind: 'computed', hardness: 1 }), 1);
  assert.equal(normalTipScale({ kind: 'computed', hardness: 0 }), 0.5);
  assert.equal(normalTipScale({ kind: 'computed', hardness: 0.6 }), 0.8);
  assert.equal(normalTipScale({ kind: 'sampled', hardness: 0 }), 1);
  const tip = { kind: 'computed', size: 100, hardness: 0, angle: 0, roundness: 1, flipX: false, flipY: false };
  const reach = (polys) => Math.max(...polys.flat().map(([x, y]) => Math.hypot(x, y)));
  assert.ok(Math.abs(reach(cursorPolygons(tip, 'full')) - 50) < 1e-6);
  assert.ok(Math.abs(reach(cursorPolygons(tip, 'outline')) - 25) < 1e-6);
  // roundness and angle come through tipOutline: a flat tip turned 90 degrees is tall
  const flat = cursorPolygons({ ...tip, hardness: 1, roundness: 0.2, angle: 90 }, 'full').flat();
  const w = Math.max(...flat.map((p) => p[0])) - Math.min(...flat.map((p) => p[0]));
  const h = Math.max(...flat.map((p) => p[1])) - Math.min(...flat.map((p) => p[1]));
  assert.ok(h > 95 && w < 25, `${w} x ${h}`);
});

test('cursor styles, Caps Lock and the cursor filter (Other Cursors)', () => {
  const app = { settings: { cursorStyle: 'dot', painting: DEFAULT_SETTINGS.painting } };
  assert.equal(paintingCursorStyle(app), 'standard');
  app.settings.cursorStyle = 'full';
  assert.equal(effectiveCursorStyle(app, { capsLock: false }), 'full');
  assert.equal(effectiveCursorStyle(app, { capsLock: true }), 'precise');
  const brush = { id: 'brush', gesture: {}, strokeDown() {} };
  const marquee = { id: 'marquee' };
  try {
    paintKeyState.capsLock = true;
    assert.equal(cursorFilter(app, 'none', { tool: brush }), 'crosshair');
    assert.equal(cursorFilter(app, 'none', { tool: { temporary: true, tool: brush } }), 'crosshair');
    paintKeyState.capsLock = false;
    assert.equal(cursorFilter(app, 'none', { tool: brush }), 'none');
  } finally {
    paintKeyState.capsLock = false;
  }
  assert.equal(cursorFilter(app, 'default', { tool: marquee }), 'default');
  app.settings.painting = { ...DEFAULT_SETTINGS.painting, cursors: { ...DEFAULT_SETTINGS.painting.cursors, other: 'precise' } };
  assert.equal(cursorFilter(app, 'default', { tool: marquee }), 'crosshair');
  assert.equal(cursorFilter(app, 'grab', { tool: marquee }), 'grab');
  assert.equal(cursorFilter(app, 'default', { tool: { id: 'move' } }), 'default');
  assert.equal(cursorFilter(app, 'url(x) 0 0, text', { tool: { id: 'type-horizontal' } }), 'url(x) 0 0, text');
  assert.equal(cursorFilter(app, 'grab', { tool: null }), 'grab');
});

test('Preferences > Cursors reads and writes settings.painting', () => {
  const s = { painting: DEFAULT_SETTINGS.painting };
  const v = cursorsPreferences.read(s);
  assert.deepEqual(v, { paintingCrosshairInTip: false, paintingCrosshairWhilePainting: false, paintingOtherCursors: 'standard', paintingPreviewColor: '#ff0000', paintingLeashColor: '#4080ff', paintingHudVertical: 'hardness' });
  assert.deepEqual(cursorsPreferences.write(v, s), {});
  const patch = cursorsPreferences.write({ ...v, paintingCrosshairInTip: true, paintingOtherCursors: 'precise', paintingPreviewColor: '#00FF00', paintingHudVertical: 'opacity' }, s);
  assert.deepEqual(patch.painting.cursors, { ...DEFAULT_SETTINGS.painting.cursors, crosshairInTip: true, other: 'precise', previewColor: '#00ff00' });
  assert.deepEqual(patch.painting.hud, { vertical: 'opacity' });
  assert.equal(patch.painting.digitPairMs, 600);
  // no cursorStyle field: the built-in "Cursors and tools" section keeps the one (skeleton-04 counts it)
  assert.ok(!cursorsPreferences.fields.some((f) => f.key === 'cursorStyle'));
  assert.equal(cursorsPreferences.id, 'cursors');
  assert.equal(cursorsPreferences.order, 21);
});
