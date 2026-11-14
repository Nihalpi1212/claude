// The `gradients` preset kind as the gradients package defines it (ARCHITECTURE.md "0.4 features", C and package 9):
// Photoshop-style groups, more built-ins, thumbnails. lib/preset-kinds.js (skeleton) registered the kind first with
// 0.3's eight presets; this registration replaces it (the later wins, user entries are kept). The 0.3 presets keep
// their ids (the slug of their 0.3 name), so files, tool settings and the index -> id mapping of the Gradient tool's
// old `preset` option keep finding them.
import { registerPresetKind } from './presets.js';
import { normalizeGradient, gradientLut } from '../../shared/pixels/gradient-model.js';
import { GRADIENT_PRESETS } from './tools/fill.js';

export const GRADIENT_KIND = 'gradients';

const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** The preset id of a 0.3 Gradient tool preset index ('0'..'7'), or null. */
export function legacyPresetId(index) {
  const p = GRADIENT_PRESETS[Number(index)];
  return /^\d+$/.test(String(index)) && p ? slug(p.name) : null;
}

/** Built-in groups, in Photoshop's order. */
export const GRADIENT_GROUPS = [
  { id: 'basics', name: 'Basics' },
  { id: 'blues', name: 'Blues' },
  { id: 'purples', name: 'Purples' },
  { id: 'pinks', name: 'Pinks' },
  { id: 'reds', name: 'Reds' },
  { id: 'oranges', name: 'Oranges' },
  { id: 'greens', name: 'Greens' },
  { id: 'grays', name: 'Grays' },
  { id: 'spectrums', name: 'Spectrums and Metals' },
  { id: 'noise', name: 'Noise' },
];

// 0.3's eight presets: the three plain ones in Basics, the five coloured ones in "Spectrums and Metals"
const LEGACY_GROUP = { 'foreground-to-background': 'basics', 'foreground-to-transparent': 'basics', 'black-to-white': 'basics' };

const two = (a, b, interpolation = 'perceptual') => ({ gradientVersion: 2, type: 'solid', interpolation, smoothness: 1, stops: [{ pos: 0, color: a }, { pos: 1, color: b }] });
const three = (a, b, c, interpolation = 'perceptual') => ({ gradientVersion: 2, type: 'solid', interpolation, smoothness: 1, stops: [{ pos: 0, color: a }, { pos: 0.5, color: b }, { pos: 1, color: c }] });

const MORE = [
  ['basics', 'Transparent Stripes', { gradientVersion: 2, type: 'solid', interpolation: 'stripes', smoothness: 0, stops: [{ pos: 0, color: { ref: 'fg' } }, { pos: 1, color: { ref: 'fg' } }], opacityStops: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1].map((pos, i) => ({ pos, mid: 0.5, opacity: i % 2 ? 0 : 1 })) }],
  ['blues', 'Sky', two('#1e64c8', '#9fd3ff')],
  ['blues', 'Deep Sea', three('#021b3a', '#0b4f8a', '#38a8d6')],
  ['blues', 'Ice', two('#d8f1ff', '#4b8fd6')],
  ['blues', 'Teal', two('#003f4f', '#29c4c0')],
  ['purples', 'Lavender', two('#5b3a9e', '#d9c7ff')],
  ['purples', 'Violet Night', three('#12002e', '#5a1ea8', '#c38bff')],
  ['purples', 'Plum', two('#3d0a3f', '#b45ab8')],
  ['pinks', 'Blush', two('#ff7aa8', '#ffe1ec')],
  ['pinks', 'Magenta', two('#8a005c', '#ff4fc1')],
  ['pinks', 'Rose Gold', three('#b76e79', '#f6c7b6', '#a85d62')],
  ['reds', 'Ember', two('#3a0000', '#ff3b1f')],
  ['reds', 'Cherry', two('#8b0016', '#ff5a6e')],
  ['reds', 'Brick', two('#5c1a0b', '#c4553a')],
  ['oranges', 'Tangerine', two('#ff6a00', '#ffc46b')],
  ['oranges', 'Amber', three('#5a2600', '#ff9500', '#ffe08a')],
  ['oranges', 'Peach', two('#ff9a76', '#ffe5d0')],
  ['greens', 'Forest', two('#0b2e13', '#3fa34d')],
  ['greens', 'Lime', two('#3a7d00', '#d4ff6b')],
  ['greens', 'Mint', two('#00a67e', '#c9ffe9')],
  ['grays', 'Charcoal', two('#1b1b1b', '#5c5c5c')],
  ['grays', 'Silver', three('#8c8c8c', '#f2f2f2', '#9a9a9a')],
  ['grays', 'Fog', two('#7f8790', '#e9edf0')],
  ['spectrums', 'Rainbow', { gradientVersion: 2, type: 'solid', interpolation: 'smooth', smoothness: 1, stops: ['#ff0000', '#ff8000', '#ffff00', '#00ff00', '#0080ff', '#4000ff', '#8000ff'].map((color, i) => ({ pos: i / 6, color })) }],
  ['spectrums', 'Gold', three('#7a5410', '#ffe9a0', '#8f6215', 'classic')],
  ['noise', 'Noise Spectrum', { gradientVersion: 2, type: 'noise', noise: { roughness: 0.5, model: 'rgb', min: [0, 0, 0], max: [1, 1, 1], restrict: true, transparency: false, seed: 1 } }],
  ['noise', 'Noise Earth', { gradientVersion: 2, type: 'noise', noise: { roughness: 0.35, model: 'hsb', min: [0.04, 0.3, 0.2], max: [0.15, 0.8, 0.8], restrict: false, transparency: false, seed: 7 } }],
  ['noise', 'Noise Stripes', { gradientVersion: 2, type: 'noise', noise: { roughness: 1, model: 'lab', min: [0, 0.3, 0.3], max: [1, 0.7, 0.7], restrict: true, transparency: false, seed: 23 } }],
];

/** The built-ins of the kind: 0.3's eight (same ids) and Photoshop-style groups. */
export function gradientBuiltins() {
  const presets = GRADIENT_PRESETS.map((g) => {
    const id = slug(g.name);
    return { id, name: g.name, group: LEGACY_GROUP[id] ?? 'spectrums', data: normalizeGradient({ stops: g.stops }, { keepRefs: true }) };
  });
  for (const [group, name, data] of MORE) presets.push({ id: slug(name), name, group, data: normalizeGradient(data, { keepRefs: true }) });
  // Basics first, then the groups in their order
  const rank = new Map(GRADIENT_GROUPS.map((g, i) => [g.id, i]));
  presets.sort((a, b) => rank.get(a.group) - rank.get(b.group));
  return { groups: GRADIENT_GROUPS.map((g) => ({ ...g, parent: null })), presets };
}

/** A thumbnail canvas of a gradient or preset: the ramp left to right over a checkerboard. */
export function gradientThumbnail(preset, size = 32, { fg, bg, height = size } = {}) {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = height;
  const ctx = c.getContext('2d');
  const cell = Math.max(2, Math.round(Math.min(size, height) / 6));
  for (let y = 0; y < height; y += cell) for (let x = 0; x < size; x += cell) {
    ctx.fillStyle = ((x / cell + y / cell) & 1) ? '#c8c8c8' : '#ffffff';
    ctx.fillRect(x, y, cell, cell);
  }
  const def = isObject(preset) && 'data' in preset ? preset.data : preset;
  const lut = gradientLut(def, { fg, bg, size });
  for (let x = 0; x < size; x++) {
    ctx.fillStyle = `rgba(${lut[x * 4]},${lut[x * 4 + 1]},${lut[x * 4 + 2]},${(lut[x * 4 + 3] / 255).toFixed(3)})`;
    ctx.fillRect(x, 0, 1, height);
  }
  return c;
}

export function registerGradientKind() {
  registerPresetKind(GRADIENT_KIND, {
    title: 'Gradients',
    version: 1,
    builtins: gradientBuiltins,
    // presets are the one stored place where { ref } stops may stay (G.1)
    normalize: (data) => (isObject(data) ? normalizeGradient(data, { keepRefs: true }) : null),
    thumbnail: (preset, size) => gradientThumbnail(preset, size),
  });
}
