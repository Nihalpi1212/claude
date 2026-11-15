// Generates src/renderer/presets/*.pigment-presets (Pigment-made libraries; every value here is Pigment's own).
import { writeFileSync, mkdirSync } from 'node:fs';
import { encodeRgba8 } from '/home/user/claude/pigment/src/shared/pixels/png.js';
import { normalizeBrush } from '/home/user/claude/pigment/src/renderer/lib/brush/preset.js';
const OUT = '/home/user/claude/pigment/src/renderer/presets';
mkdirSync(OUT, { recursive: true });
const file = (kind, groups, items, blobs = {}) => ({ format: 'pigment-presets', version: 1, kind, kindVersion: 1, groups, items, hidden: [], blobs });
const write = (name, obj) => writeFileSync(`${OUT}/${name}`, JSON.stringify(obj) + '\n');
const hex2 = (v) => Math.round(v).toString(16).padStart(2, '0');
const libs = [];
const add = (id, f, kind, name) => { libs.push({ id, file: f, kind, name }); };

// swatches: web-safe colours (216)
{
  const items = [];
  const steps = [0, 51, 102, 153, 204, 255];
  for (const r of steps) for (const g of steps) for (const b of steps) items.push({ id: `w${items.length}`, name: `#${hex2(r)}${hex2(g)}${hex2(b)}`, group: 'web', data: { color: { space: 'rgb', values: [r, g, b] } } });
  write('swatches-web-safe.pigment-presets', file('swatches', [{ id: 'web', name: 'Web Safe Colors', parent: null }], items));
  add('swatches-web-safe', 'swatches-web-safe.pigment-presets', 'swatches', 'Web Safe Colors');
}
// swatches: greys in 5 % steps of ink
{
  const items = [];
  for (let k = 0; k <= 100; k += 5) items.push({ id: `g${k}`, name: k === 0 ? 'White' : k === 100 ? 'Black' : `${k}% Gray`, group: 'grays', data: { color: { space: 'gray', values: [k] } } });
  write('swatches-grays.pigment-presets', file('swatches', [{ id: 'grays', name: 'Grays', parent: null }], items));
  add('swatches-grays', 'swatches-grays.pigment-presets', 'swatches', 'Grays');
}
// swatches: a hue wheel in three lightnesses
{
  const items = [];
  const hsv = (h, s, v) => { const f = (n) => { const k = (n + h / 60) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); }; return [f(5), f(3), f(1)].map((x) => Math.round(x * 255)); };
  const names = ['Red', 'Orange', 'Yellow', 'Lime', 'Green', 'Spring Green', 'Cyan', 'Azure', 'Blue', 'Violet', 'Magenta', 'Rose'];
  for (const [tone, s, v] of [['Pastel', 0.35, 1], ['Bright', 1, 1], ['Deep', 1, 0.55]]) names.forEach((n, i) => items.push({ id: `${tone}-${i}`, name: `${tone} ${n}`, group: tone.toLowerCase(), data: { color: { space: 'rgb', values: hsv(i * 30, s, v) } } }));
  write('swatches-hue-wheel.pigment-presets', file('swatches', [{ id: 'pastel', name: 'Pastel', parent: null }, { id: 'bright', name: 'Bright', parent: null }, { id: 'deep', name: 'Deep', parent: null }], items));
  add('swatches-hue-wheel', 'swatches-hue-wheel.pigment-presets', 'swatches', 'Hue Wheel');
}
// gradients
{
  const st = (pos, color, mid = 0.5) => ({ pos, mid, color });
  const op = (pos, opacity, mid = 0.5) => ({ pos, mid, opacity });
  const g = (stops, opacityStops = [op(0, 1), op(1, 1)], interpolation = 'perceptual') => ({ gradientVersion: 2, type: 'solid', interpolation, smoothness: 1, stops, opacityStops });
  const items = [
    ['Spectrum', g([st(0, '#ff0000'), st(1 / 6, '#ffff00'), st(2 / 6, '#00ff00'), st(3 / 6, '#00ffff'), st(4 / 6, '#0000ff'), st(5 / 6, '#ff00ff'), st(1, '#ff0000')], undefined, 'classic')],
    ['Transparent Spectrum', g([st(0, '#ff0000'), st(0.25, '#ffff00'), st(0.5, '#00ff00'), st(0.75, '#00ffff'), st(1, '#0000ff')], [op(0, 0), op(0.15, 1), op(0.85, 1), op(1, 0)], 'classic')],
    ['Copper', g([st(0, '#4a2210'), st(0.35, '#c87533'), st(0.5, '#f2c39b'), st(0.7, '#a0522d'), st(1, '#3b1a0c')])],
    ['Silver', g([st(0, '#5a5f66'), st(0.3, '#d9dde2'), st(0.5, '#ffffff'), st(0.7, '#aab0b8'), st(1, '#4a4f55')])],
    ['Brass', g([st(0, '#5c4610'), st(0.4, '#d4af37'), st(0.55, '#fff0b3'), st(0.75, '#b8860b'), st(1, '#4d3a0a')])],
    ['Sunrise', g([st(0, '#1b1f4a'), st(0.45, '#b0306a'), st(0.75, '#ff8a3d'), st(1, '#ffe07a')])],
    ['Sea', g([st(0, '#032a3a'), st(0.5, '#0b7a8a'), st(1, '#9fe8e0')])],
    ['Foreground to Transparent Fade', g([st(0, { ref: 'fg' }), st(1, { ref: 'fg' })], [op(0, 1), op(1, 0, 0.35)])],
  ].map(([name, data], i) => ({ id: `gr${i}`, name, group: 'pigment', data }));
  write('gradients-pigment.pigment-presets', file('gradients', [{ id: 'pigment', name: 'Pigment Gradients', parent: null }], items));
  add('gradients-pigment', 'gradients-pigment.pigment-presets', 'gradients', 'Pigment Gradients');
}
// shapes (0..1 box)
{
  const poly = (pts) => ({ subpaths: [{ closed: true, points: pts.map(([x, y]) => ({ x: +x.toFixed(4), y: +y.toFixed(4) })) }] });
  const star = (n, inner) => poly(Array.from({ length: n * 2 }, (_, i) => { const a = -Math.PI / 2 + (i * Math.PI) / n; const r = i % 2 ? inner : 0.5; return [0.5 + r * Math.cos(a), 0.5 + r * Math.sin(a)]; }));
  const k = 0.5523;
  const heart = { subpaths: [{ closed: true, points: [
    { x: 0.5, y: 0.25, inX: 0.45, inY: 0.05, outX: 0.55, outY: 0.05 },
    { x: 1, y: 0.3, inX: 0.95, inY: 0.02, outX: 1.03, outY: 0.55 },
    { x: 0.5, y: 0.95, inX: 0.8, inY: 0.7, outX: 0.2, outY: 0.7 },
    { x: 0, y: 0.3, inX: -0.03, inY: 0.55, outX: 0.05, outY: 0.02 },
  ] }] };
  void k;
  const items = [
    ['Five-Point Star', star(5, 0.2)],
    ['Six-Point Star', star(6, 0.28)],
    ['Burst', star(12, 0.36)],
    ['Arrow Right', poly([[0, 0.35], [0.6, 0.35], [0.6, 0.1], [1, 0.5], [0.6, 0.9], [0.6, 0.65], [0, 0.65]])],
    ['Double Arrow', poly([[0, 0.5], [0.3, 0.15], [0.3, 0.35], [0.7, 0.35], [0.7, 0.15], [1, 0.5], [0.7, 0.85], [0.7, 0.65], [0.3, 0.65], [0.3, 0.85]])],
    ['Plus', poly([[0.35, 0], [0.65, 0], [0.65, 0.35], [1, 0.35], [1, 0.65], [0.65, 0.65], [0.65, 1], [0.35, 1], [0.35, 0.65], [0, 0.65], [0, 0.35], [0.35, 0.35]])],
    ['Speech Bubble', poly([[0, 0], [1, 0], [1, 0.7], [0.45, 0.7], [0.2, 1], [0.25, 0.7], [0, 0.7]])],
    ['Heart', heart],
  ].map(([name, path], i) => ({ id: `s${i}`, name, group: 'pigment', data: { path } }));
  write('shapes-pigment.pigment-presets', file('shapes', [{ id: 'pigment', name: 'Pigment Shapes', parent: null }], items));
  add('shapes-pigment', 'shapes-pigment.pigment-presets', 'shapes', 'Pigment Shapes');
}
// patterns: PNG side files
{
  const make = (w, h, fn) => { const d = new Uint8ClampedArray(w * h * 4); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const [r, g, b, a = 255] = fn(x, y); const i = (y * w + x) * 4; d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = a; } return { width: w, height: h, data: d }; };
  const defs = [
    ['Horizontal Stripes', 'pigment-hstripes.png', make(8, 8, (x, y) => (y < 4 ? [40, 40, 40] : [235, 235, 235]))],
    ['Vertical Stripes', 'pigment-vstripes.png', make(8, 8, (x) => (x < 4 ? [40, 40, 40] : [235, 235, 235]))],
    ['Crosshatch', 'pigment-crosshatch.png', make(12, 12, (x, y) => ((x + y) % 6 === 0 || (x - y + 12) % 6 === 0 ? [30, 30, 30] : [245, 245, 245]))],
    ['Polka Dots', 'pigment-polka.png', make(16, 16, (x, y) => { const d = Math.hypot(x - 7.5, y - 7.5); return d < 4 ? [200, 40, 60] : [252, 246, 236]; })],
    ['Halftone', 'pigment-halftone.png', make(8, 8, (x, y) => { const d = Math.hypot(x - 3.5, y - 3.5); return [0, 0, 0, d < 2.5 ? 255 : 0]; })],
  ];
  const blobs = {};
  const items = [];
  for (const [name, blob, img] of defs) {
    blobs[blob] = Buffer.from(await encodeRgba8(img)).toString('base64');
    items.push({ id: blob.replace('.png', ''), name, group: 'pigment', data: { width: img.width, height: img.height, blob, mode: 'rgb' } });
  }
  write('patterns-pigment.pigment-presets', file('patterns', [{ id: 'pigment', name: 'Pigment Patterns', parent: null }], items, blobs));
  add('patterns-pigment', 'patterns-pigment.pigment-presets', 'patterns', 'Pigment Patterns');
}
// styles
{
  const items = [
    ['Soft Shadow', { dropShadow: { enabled: true, blend: 'multiply', color: '#000000', opacity: 0.45, angle: 120, distance: 6, spread: 0, size: 12 } }],
    ['Outline', { stroke: { enabled: true, size: 3, position: 'outside', color: '#000000', opacity: 1, blend: 'normal' } }],
    ['Embossed', { bevel: { enabled: true, style: 'inner-bevel', technique: 'smooth', depth: 120, direction: 'up', size: 6, soften: 2, angle: 120, altitude: 30, highlightColor: '#ffffff', highlightOpacity: 0.75, highlightBlend: 'screen', shadowColor: '#000000', shadowOpacity: 0.6, shadowBlend: 'multiply' } }],
    ['Glow', { outerGlow: { enabled: true, blend: 'screen', color: '#fff3a0', opacity: 0.8, spread: 0, size: 14 } }],
    ['Sticker', { stroke: { enabled: true, size: 6, position: 'outside', color: '#ffffff', opacity: 1, blend: 'normal' }, dropShadow: { enabled: true, blend: 'multiply', color: '#000000', opacity: 0.35, angle: 120, distance: 3, spread: 0, size: 6 } }],
  ].map(([name, styles], i) => ({ id: `st${i}`, name, group: 'pigment', data: { styles } }));
  write('styles-pigment.pigment-presets', file('styles', [{ id: 'pigment', name: 'Pigment Styles', parent: null }], items));
  add('styles-pigment', 'styles-pigment.pigment-presets', 'styles', 'Pigment Styles');
}
// brushes: dry media (computed tips and the built-in patterns)
{
  const c = (type) => ({ type, fadeSteps: 25 });
  const items = [
    ['Sketch Pencil', { tip: { size: 4, hardness: 0.9, spacing: 0.1 }, transfer: { enabled: true, opacityControl: c('pen-pressure'), flowControl: c('pen-pressure') }, texture: { enabled: true, pattern: { presetId: 'noise', name: 'Noise' }, scale: 0.5, mode: 'multiply', depth: 0.4 } }],
    ['Charcoal', { tip: { size: 24, hardness: 0.4, roundness: 0.6, angle: 35, spacing: 0.15 }, shapeDynamics: { enabled: true, sizeJitter: 0.2, angleJitter: 0.1 }, scattering: { enabled: true, scatter: 0.4, count: 2 }, texture: { enabled: true, pattern: { presetId: 'burlap', name: 'Burlap' }, scale: 1, mode: 'height', depth: 0.8, eachTip: true } }],
    ['Soft Pastel', { tip: { size: 40, hardness: 0.2, spacing: 0.2 }, noise: true, texture: { enabled: true, pattern: { presetId: 'noise', name: 'Noise' }, scale: 1, mode: 'subtract', depth: 0.5 }, transfer: { enabled: true, opacityControl: c('pen-pressure') } }],
    ['Ink Pen', { tip: { size: 6, hardness: 1, spacing: 0.05 }, shapeDynamics: { enabled: true, sizeControl: c('pen-pressure'), minimumDiameter: 0.25 } }],
    ['Dry Brush', { tip: { size: 30, hardness: 0.7, roundness: 0.3, angle: 20, spacing: 0.08 }, scattering: { enabled: true, scatter: 0.15, count: 3, bothAxes: true }, transfer: { enabled: true, flowJitter: 0.4 } }],
  ].map(([name, b], i) => ({ id: `dm${i}`, name, group: 'dry', data: normalizeBrush(b) }));
  write('brushes-dry-media.pigment-presets', file('brushes', [{ id: 'dry', name: 'Dry Media', parent: null }], items));
  add('brushes-dry-media', 'brushes-dry-media.pigment-presets', 'brushes', 'Dry Media');
}
writeFileSync(`${OUT}/index.json`, JSON.stringify({ about: 'Pigment-made preset libraries (ARCHITECTURE.md "0.5 features", S10.5): offered by the Preset Manager and the panels; every value is Pigment\'s own.', libraries: libs }, null, 2) + '\n');
console.log(libs.length, 'libraries');
