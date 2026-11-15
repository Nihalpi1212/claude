// color-picker-swatches (ARCHITECTURE.md "0.5 features", package 11): the pure parts of the colour UI in
// lib/color-picker-model.js: the picker's nine axes, web colours, the Lab gamut check (with icc-engine's real
// conversions), the HUD colour picker's state machine, swatch data and 0.4's palette migration, .acb colour books and
// the Eyedropper's sample choices.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../../src/renderer/lib/color-picker-model.js';
import * as PR from '../../src/renderer/lib/color/profiles.js';
import * as T from '../../src/renderer/lib/color/transforms.js';
import { parseAse, writeAse } from '../../src/renderer/lib/preset-files/aco-ase.js';

const near = (a, b, eps = 1e-6, msg = '') => {
  assert.equal(a.length, b.length, msg);
  for (let i = 0; i < a.length; i++) assert.ok(Math.abs(a[i] - b[i]) <= eps, `${msg} [${i}] ${a[i]} vs ${b[i]}`);
};

test('axes: every axis puts the colour where a click on its field and strip reads it back', () => {
  const st = M.stateFromRgb([200, 80, 40]);
  for (const axis of M.AXES) {
    const p = M.axisPosition(axis.id, st);
    for (const k of ['x', 'y', 't']) assert.ok(p[k] >= -1e-9 && p[k] <= 1 + 1e-9, `${axis.id}.${k} = ${p[k]}`);
    const viaField = M.fromField(axis.id, st, p.x, p.y);
    const viaStrip = M.fromStrip(axis.id, st, p.t);
    // Lab axes round through the 8-bit RGB the colour is stored as
    const eps = axis.model === 'lab' ? 2 : 0.6;
    near(viaField.rgb, st.rgb, eps, `field ${axis.id}`);
    near(viaStrip.rgb, st.rgb, eps, `strip ${axis.id}`);
    // what the field draws at the colour's own position is the colour
    near(M.fieldRgb(axis.id, st, p.x, p.y), st.rgb, eps, `draw ${axis.id}`);
  }
});

test('axes: the H field is saturation by brightness under the hue strip; a grey keeps the hue chosen', () => {
  let st = M.stateFromHsv({ h: 120, s: 1, v: 1 });
  assert.deepEqual(M.stateHex(st), '#00ff00');
  st = M.fromField('h', st, 0, 0.5); // no saturation: a grey
  assert.equal(M.stateHex(st), '#808080');
  assert.equal(Math.round(st.hsv.h), 120);
  st = M.fromField('h', st, 1, 0); // back to full saturation: still green
  assert.equal(M.stateHex(st), '#00ff00');
  // the hue strip: top is 360 (red), bottom 0 (red), a third of the way up is green
  assert.deepEqual(M.stripRgb('h', st, 1 / 3).map(Math.round), [0, 255, 0]);
  st = M.fromStrip('h', st, 2 / 3);
  assert.equal(M.stateHex(st), '#0000ff');
  // the R axis: the field is blue (x) by green (y), the strip red
  const r = M.fromField('r', M.stateFromRgb([10, 20, 30]), 1, 0);
  assert.deepEqual(r.rgb.map(Math.round), [10, 255, 255]);
  assert.deepEqual(M.fromStrip('r', r, 1).rgb.map(Math.round), [255, 255, 255]);
});

test('axes: Lab fields keep what was typed and go through the conversions given', () => {
  const st = M.stateFromLab([50, 20, -30]);
  near(st.lab, [50, 20, -30]);
  near(M.SRGB_CONV.toLab(st.rgb), [50, 20, -30], 0.8);
  const moved = M.fromStrip('L', st, 0.8);
  near(moved.lab, [80, 20, -30]);
  // a conv that records its calls proves the field reads the injected conversion
  const calls = [];
  const conv = { toLab: (rgb) => M.SRGB_CONV.toLab(rgb), fromLab: (lab) => (calls.push(lab), M.SRGB_CONV.fromLab(lab)) };
  M.fieldRgb('L', st, 0.5, 0.5, conv);
  assert.equal(calls.length, 1);
  near(calls[0], [50, 0.5 * 255 - 128, 0.5 * 255 - 128]);
  const buf = new Uint8ClampedArray(4 * 4 * 4);
  M.renderField('A', st, buf, 4, 4, { conv });
  assert.equal(calls.length, 17);
});

test('web colours: snapping, the check, and the posterised field', () => {
  assert.deepEqual(M.webSafe([30, 26, 128]), [51, 51, 153]);
  assert.deepEqual(M.webSafe([0, 255, 25]), [0, 255, 0]);
  assert.equal(M.isWebSafe([51, 102, 255]), true);
  assert.equal(M.isWebSafe([50, 102, 255]), false);
  const buf = new Uint8ClampedArray(16 * 16 * 4);
  M.renderField('h', M.stateFromHsv({ h: 30, s: 1, v: 1 }), buf, 16, 16, { web: true });
  for (let i = 0; i < buf.length; i += 4) assert.ok(M.isWebSafe([buf[i], buf[i + 1], buf[i + 2]]));
});

test('Lab gamut: with icc-engine\'s conversions a Lab colour sRGB cannot hold is flagged, and one Display P3 holds is not', () => {
  const rec = (id) => ({ id, bytes: id === 'srgb' ? null : PR.builtinIcc(id), wellKnown: PR.BUILTIN_DEFS.find((d) => d.id === id).wellKnown });
  const convFor = (p) => ({ toLab: (rgb) => T.rgbToLab(rgb, p), fromLab: (lab) => T.labToRgb(lab, p).map((v) => Math.max(0, Math.min(255, Math.round(v)))) });
  const srgb = convFor(rec('srgb')), p3 = convFor(rec('display-p3'));
  // a saturated green just outside sRGB, inside Display P3 (D50 Lab)
  const green = [80, -95, 75];
  assert.equal(M.labClipped(green, srgb), true);
  assert.equal(M.labClipped(green, p3), false);
  // a mid grey is in every gamut
  assert.equal(M.labClipped([50, 0, 0], srgb), false);
  // the stub maths agree on the out-of-gamut colour
  assert.equal(M.labClipped([60, 120, -120]), true);
});

test('printable colour: the warning\'s closest printable colour passes the gamut test; a printable colour is kept', async () => {
  const { isOutOfCmykGamut } = await import('../../src/shared/pixels/color.js');
  let flagged = 0;
  for (let r = 0; r <= 255; r += 51) for (let g = 0; g <= 255; g += 51) for (let b = 0; b <= 255; b += 51) {
    const c = [r, g, b];
    const p = M.printableRgb(c);
    assert.equal(isOutOfCmykGamut(p), false, String(c));
    if (isOutOfCmykGamut(c)) flagged++;
    else assert.deepEqual(p, c);
  }
  assert.ok(flagged > 10);
});

test('HUD model (hue strip): the press lands on the colour; the square sets S and B, the strip the hue only', () => {
  const m = new M.HudModel({ hsv: { h: 200, s: 0.25, v: 0.75 }, layout: 'strip', size: 160 });
  const a = m.anchor();
  assert.deepEqual(m.move(a.x, a.y), { hsv: { h: 200, s: 0.25, v: 0.75 }, zone: 'square' });
  // right and up in the square: more saturation and brightness, same hue
  let r = m.move(a.x + 80, a.y - 40);
  assert.equal(r.zone, 'square');
  assert.equal(r.hsv.h, 200);
  near([r.hsv.s, r.hsv.v], [0.75, 1]);
  // into the strip: the hue follows the height, S and B stay
  const s = m.strip;
  r = m.move(s.x + s.width / 2, s.y + s.height / 2);
  assert.equal(r.zone, 'hue');
  near([r.hsv.h, r.hsv.s, r.hsv.v], [180, 0.75, 1]);
  // back into the square: the new hue stays
  r = m.move(m.square.x + 10, m.square.y + m.square.size);
  assert.equal(r.zone, 'square');
  near([r.hsv.h, r.hsv.s, r.hsv.v], [180, 10 / 160, 0]);
  // far outside: clamped
  r = m.move(-500, -500);
  near([r.hsv.s, r.hsv.v], [0, 1]);
  r = m.move(9999, 9999);
  assert.equal(r.zone, 'hue');
  assert.ok(r.hsv.h < 360 && r.hsv.h > 359);
  assert.ok(m.width > m.square.size + s.width && m.height > m.square.size);
});

test('HUD model (hue wheel): the ring sets the hue by its angle, clockwise from the top', () => {
  const m = new M.HudModel({ hsv: { h: 10, s: 1, v: 1 }, layout: 'wheel', size: 120 });
  const c = m.center, R = (m.ring.inner + m.ring.outer) / 2;
  let r = m.move(c.x, c.y - R);
  assert.equal(r.zone, 'hue');
  near([r.hsv.h], [0], 1e-6);
  r = m.move(c.x + R, c.y);
  near([r.hsv.h], [90]);
  r = m.move(c.x, c.y + R);
  near([r.hsv.h], [180]);
  r = m.move(c.x - R, c.y);
  near([r.hsv.h], [270]);
  // the centre is the square: half saturation and brightness
  r = m.move(c.x, c.y);
  assert.equal(r.zone, 'square');
  near([r.hsv.h, r.hsv.s, r.hsv.v], [270, 0.5, 0.5]);
  const hm = m.hueMarker();
  assert.ok(Math.abs(Math.hypot(hm.x - c.x, hm.y - c.y) - R) < 1e-6);
  assert.deepEqual(M.hudStyle('hue-wheel-large'), { id: 'hue-wheel-large', layout: 'wheel', size: 220 });
  assert.deepEqual(M.hudStyle('nonsense'), { id: 'hue-strip', layout: 'strip', size: 160 });
});

test('HUD session state machine: live foreground, one remembered colour on up, cancel restores, ends once', () => {
  const log = [];
  const host = { setForeground: (h) => log.push(['fg', h]), remember: (h) => log.push(['recent', h]), done: (v) => log.push(['done', v]) };
  const view = { update: () => log.push(['draw']), destroy: () => log.push(['destroy']) };
  const s = new M.HudController({ initial: '#ff0000', layout: 'strip', size: 100, host, view });
  const a = s.anchor;
  assert.deepEqual(a, { x: 8 + 100, y: 8 }); // red: full saturation and brightness, the square's top-right
  s.move(a.x, a.y); // no change, no foreground write
  assert.deepEqual(log.filter((e) => e[0] === 'fg'), []);
  s.move(a.x - 50, a.y + 50); // half saturation, half brightness
  assert.deepEqual(log.filter((e) => e[0] === 'fg'), [['fg', '#804040']]);
  assert.equal(s.up(a.x - 50, a.y + 50), '#804040');
  assert.deepEqual(log.slice(-3), [['recent', '#804040'], ['destroy'], ['done', '#804040']]);
  // ended: nothing more happens
  const n = log.length;
  s.move(0, 0);
  s.cancel();
  assert.equal(s.up(), null);
  assert.equal(log.length, n);

  const log2 = [];
  const host2 = { setForeground: (h) => log2.push(['fg', h]), remember: (h) => log2.push(['recent', h]), done: (v) => log2.push(['done', v]) };
  const c = new M.HudController({ initial: '#00ff00', host: host2 });
  c.move(c.anchor.x - 40, c.anchor.y + 40);
  c.cancel();
  assert.deepEqual(log2.map((e) => e[0]), ['fg', 'fg', 'done']);
  assert.deepEqual(log2[1], ['fg', '#00ff00']);
  assert.deepEqual(log2[2], ['done', null]);
  // a cancel without a move writes nothing
  const log3 = [];
  new M.HudController({ initial: '#123456', host: { setForeground: (h) => log3.push(h), done: () => {} } }).cancel();
  assert.deepEqual(log3, []);
});

test('recent colours: newest first, no repeats, at most 14', () => {
  assert.deepEqual(M.addRecentColor(['#000000', '#FF0000'], '#ff0000'), ['#ff0000', '#000000']);
  const many = Array.from({ length: 20 }, (_, i) => `#0000${i.toString(16).padStart(2, '0')}`);
  const out = M.addRecentColor(many, '#ffffff');
  assert.equal(out.length, 14);
  assert.equal(out[0], '#ffffff');
});

test('swatch data: normalised, clamped, spot type and book kept; values from a ColorValue', () => {
  assert.deepEqual(M.normalizeSwatchData({ color: { space: 'rgb', values: [300, -2, 12.5] } }), { color: { space: 'rgb', values: [255, 0, 12.5] } });
  assert.deepEqual(M.normalizeSwatchData({ color: { space: 'lab', values: [50, 200, -10] }, type: 'spot', book: { book: 'B', name: 'N' } }), { color: { space: 'lab', values: [50, 127, -10] }, type: 'spot', book: { book: 'B', name: 'N' } });
  assert.deepEqual(M.normalizeSwatchData({ color: { space: 'gray', values: [40] }, type: 'process' }), { color: { space: 'gray', values: [40] } });
  assert.equal(M.normalizeSwatchData({ color: { space: 'hsv', values: [1, 2, 3] } }), null);
  assert.equal(M.normalizeSwatchData({ color: { space: 'cmyk', values: [1, 2, 3] } }), null);
  assert.equal(M.normalizeSwatchData(null), null);
  assert.deepEqual(M.swatchFromColorValue({ hex: '#102030', space: 'rgb' }), { color: { space: 'rgb', values: [16, 32, 48] } });
  assert.deepEqual(M.swatchFromColorValue({ hex: '#102030', lab: [12.4, 1.6, -9.6], space: 'lab' }), { color: { space: 'lab', values: [12, 2, -10] } });
  assert.deepEqual(M.swatchFromColorValue({ hex: '#102030', lab: [12.4, 1.6, -9.5], book: { book: 'Mine', name: 'Navy' }, space: 'book' }), { color: { space: 'lab', values: [12.4, 1.6, -9.5] }, type: 'spot', book: { book: 'Mine', name: 'Navy' } });
});

test('migration: 0.4\'s palette (hex strings and named entries) becomes presets in order', () => {
  const out = M.migrateSwatchList(['#123456', { color: '#ABCDEF', name: ' Sky ' }, 'nonsense', { color: 12 }, '#fff', { color: '#00ff00' }]);
  assert.deepEqual(out, [
    { name: '#123456', data: { color: { space: 'rgb', values: [18, 52, 86] } } },
    { name: 'Sky', data: { color: { space: 'rgb', values: [171, 205, 239] } } },
    { name: '#ffffff', data: { color: { space: 'rgb', values: [255, 255, 255] } } },
    { name: '#00ff00', data: { color: { space: 'rgb', values: [0, 255, 0] } } },
  ]);
  assert.deepEqual(M.migrateSwatchList(null), []);
});

test('swatch search: by name, by hex, by book colour name', () => {
  const hexOf = (d) => M.hexOfRgb(d.color.values);
  const list = [
    { name: 'Sky', data: { color: { space: 'rgb', values: [135, 206, 235] } } },
    { name: 'Brick', data: { color: { space: 'rgb', values: [170, 50, 40] } } },
    { name: 'x', data: { color: { space: 'rgb', values: [0, 0, 0] }, book: { book: 'B', name: 'Midnight' } } },
  ];
  assert.deepEqual(M.filterSwatches(list, 'sk', hexOf).map((p) => p.name), ['Sky']);
  assert.deepEqual(M.filterSwatches(list, '#aa32', hexOf).map((p) => p.name), ['Brick']);
  assert.deepEqual(M.filterSwatches(list, 'MIDN', hexOf).map((p) => p.name), ['x']);
  assert.equal(M.filterSwatches(list, '', hexOf).length, 3);
});

test('.acb: a written book reads back (RGB, Lab, CMYK), Adobe\'s $$$ strings resolve, fillers are skipped', () => {
  const rgb = M.writeAcb({ title: '$$$/colorbook/TEST/title=Test Book^R', prefix: 'TB ', postfix: ' C', description: 'For tests', colorSpace: 'rgb', colors: [
    { name: '100', code: 'T100', color: { values: [255, 0, 0] } },
    { name: '', code: '', color: { values: [0, 0, 0] } },
    { name: '200', code: 'T200', color: { values: [0, 128, 255] } },
  ] });
  const b = M.parseAcb(rgb);
  assert.deepEqual(b.report, []);
  assert.equal(b.title, 'Test Book®');
  assert.equal(b.colorSpace, 'rgb');
  assert.deepEqual(b.colors.map((c) => [c.name, c.code, c.color.values, c.type]), [['100', 'T100', [255, 0, 0], 'spot'], ['200', 'T200', [0, 128, 255], 'spot']]);
  assert.equal(M.bookColorName(b, b.colors[0]), 'TB 100 C');
  assert.deepEqual(M.filterBookColors(b, 'tb 2').map((c) => c.name), ['200']);
  assert.deepEqual(M.filterBookColors(b, 't100').map((c) => c.name), ['100']);

  const lab = M.parseAcb(M.writeAcb({ title: 'L', colorSpace: 'lab', colors: [{ name: 'a', code: 'A', color: { values: [50, -20, 30] } }], process: true }));
  near(lab.colors[0].color.values, [50, -20, 30], 0.45);
  assert.equal(lab.colors[0].type, 'process');
  const cmyk = M.parseAcb(M.writeAcb({ title: 'C', colorSpace: 'cmyk', colors: [{ name: 'c', code: 'C', color: { values: [100, 0, 50, 20] } }] }));
  near(cmyk.colors[0].color.values, [100, 0, 50, 20], 0.25);
});

test('.acb: damaged and foreign files report and never throw', () => {
  const good = M.writeAcb({ title: 'T', colors: [{ name: 'one', code: '1', color: { values: [1, 2, 3] } }, { name: 'two', code: '2', color: { values: [4, 5, 6] } }] });
  const cut = M.parseAcb(good.slice(0, good.length - 20));
  assert.equal(cut.colors.length, 1);
  assert.match(cut.report[0], /damaged/);
  assert.match(M.parseAcb(new Uint8Array([1, 2, 3, 4, 5])).report[0], /not an Adobe Color Book/);
  assert.match(M.parseAcb(new Uint8Array(0)).report[0], /damaged/);
  const odd = good.slice();
  odd[odd.length - 8 - 2 * (9 + 3 + 6 + 4 + 2 * 3)] = 0; // somewhere in the middle: still never throws
  assert.doesNotThrow(() => M.parseAcb(odd));
});

test('a book from an .ase file (Load Book…): every colour in file order, named by the file', () => {
  const { bytes } = writeAse({ groups: [{ name: 'Warm', colors: [{ name: 'Sun', color: { space: 'rgb', values: [255, 200, 0] }, type: 'spot' }] }], colors: [{ name: 'Ink', color: { space: 'lab', values: [20, 5, -5] }, type: 'global' }] });
  const book = M.bookFromAse(parseAse(bytes), '/x/My Colors.ase');
  assert.equal(book.title, 'My Colors');
  assert.equal(book.colorSpace, 'mixed');
  assert.deepEqual(book.colors.map((c) => [c.name, c.color.space, c.type]), [['Ink', 'lab', 'spot'], ['Sun', 'rgb', 'spot']]);
});

test('eyedropper: the five Sample choices map to sampleMerged; averages weigh alpha; hex and HTML codes', () => {
  const a = { id: 'a' }, b = { id: 'b' };
  const above = (l) => (l === a ? b : null);
  assert.deepEqual(M.sampleSourceOf('layer', a, above), { layer: true });
  assert.deepEqual(M.sampleSourceOf('merged', a, above), { layer: false, until: null, all: false, skipAdjustments: false });
  assert.deepEqual(M.sampleSourceOf('merged-no-adj', a, above), { layer: false, until: null, all: false, skipAdjustments: true });
  assert.deepEqual(M.sampleSourceOf('below', a, above), { layer: false, until: b, all: false, skipAdjustments: false });
  assert.deepEqual(M.sampleSourceOf('below-no-adj', b, above), { layer: false, until: null, all: true, skipAdjustments: true });
  assert.deepEqual(M.SAMPLE_SIZES.map(([v]) => v), ['1', '3', '5', '11', '31', '51', '101']);
  assert.deepEqual(M.averageRgba(new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 255, 0])), [255, 0, 0, 0.5]);
  assert.equal(M.averageRgba(new Uint8ClampedArray([1, 2, 3, 0])), null);
  assert.equal(M.hexCode('#FF8800'), 'ff8800');
  assert.equal(M.htmlCode('#ff8800'), 'COLOR="#ff8800"');
});
