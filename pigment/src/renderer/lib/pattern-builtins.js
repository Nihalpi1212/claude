// The built-in patterns of the `patterns` preset kind (patterns package, ARCHITECTURE.md "0.4 features", package 10).
// Photoshop ships a library of default patterns; Pigment draws its own here, procedurally, so no image files ship and
// the pixels are the same on every machine (every generator is seeded). Each one tiles seamlessly: the noise lattices
// wrap at the tile size. Pure: no DOM, so Node unit tests run it. A preset's data names its generator
// ({ width, height, builtin: id, mode: 'rgb' }); lib/patterns.js turns it into a canvas when the library loads.
import { seededRandom } from '../../shared/pixels/gradient-model.js';

export const BUILTIN_GROUPS = [
  { id: 'basic', name: 'Basic' },
  { id: 'textures', name: 'Textures' },
];

/** [id, name, group, width, height] of every built-in pattern, in the order the library lists them. */
export const BUILTIN_PATTERNS = [
  ['checkerboard', 'Checkerboard', 'basic', 16, 16],
  ['diagonal-lines', 'Diagonal Lines', 'basic', 16, 16],
  ['grid', 'Grid', 'basic', 16, 16],
  ['dots', 'Dots', 'basic', 12, 12],
  ['bricks', 'Bricks', 'basic', 32, 16],
  ['weave', 'Weave', 'basic', 16, 16],
  ['noise', 'Noise', 'textures', 64, 64],
  ['clouds', 'Clouds', 'textures', 128, 128],
  ['wood', 'Wood', 'textures', 128, 128],
  ['burlap', 'Burlap', 'textures', 64, 64],
  ['water', 'Water', 'textures', 128, 128],
  ['grass', 'Grass', 'textures', 96, 96],
];

const clamp8 = (v) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));
const smooth = (t) => t * t * (3 - 2 * t);

/** Value noise on a lattice of `cells` × `rows` that wraps, sampled at (u, v) in 0..1 of the tile. */
function wrapNoise(cells, seed, rows = cells) {
  const rnd = seededRandom(seed);
  const lattice = new Float64Array(cells * rows);
  for (let i = 0; i < lattice.length; i++) lattice[i] = rnd();
  return (u, v) => {
    const x = u * cells, y = v * rows;
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const fx = smooth(x - x0), fy = smooth(y - y0);
    const at = (i, j) => lattice[(((j % rows) + rows) % rows) * cells + (((i % cells) + cells) % cells)];
    const a = at(x0, y0), b = at(x0 + 1, y0), c = at(x0, y0 + 1), d = at(x0 + 1, y0 + 1);
    return (a + (b - a) * fx) + ((c + (d - c) * fx) - (a + (b - a) * fx)) * fy;
  };
}

/** Fractal noise (octaves of wrapping value noise), 0..1. */
function fractal(base, octaves, seed) {
  const layers = [];
  for (let o = 0; o < octaves; o++) layers.push(wrapNoise(base << o, seed + o * 101));
  return (u, v) => {
    let sum = 0, amp = 1, norm = 0;
    for (const n of layers) {
      sum += n(u, v) * amp;
      norm += amp;
      amp /= 2;
    }
    return sum / norm;
  };
}

/** The pixels of a built-in pattern: { width, height, data: Uint8ClampedArray (RGBA) }, or null for an unknown id. */
export function builtinPattern(id) {
  const spec = BUILTIN_PATTERNS.find((p) => p[0] === id);
  if (!spec) return null;
  const [, , , w, h] = spec;
  const data = new Uint8ClampedArray(w * h * 4);
  const put = (x, y, r, g, b, a = 255) => {
    const i = (y * w + x) * 4;
    data[i] = clamp8(r);
    data[i + 1] = clamp8(g);
    data[i + 2] = clamp8(b);
    data[i + 3] = clamp8(a);
  };
  const grey = (x, y, v) => put(x, y, v, v, v);
  const rnd = seededRandom(0x9e37 + id.length * 7919);
  switch (id) {
    case 'checkerboard':
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) grey(x, y, (x < 8) !== (y < 8) ? 96 : 208);
      break;
    case 'diagonal-lines':
      // a 2 px dark line every 8 px along x + y: 16 is a multiple of 8, so it tiles
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) grey(x, y, (x + y) % 8 < 2 ? 64 : 230);
      break;
    case 'grid':
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) grey(x, y, x === 0 || y === 0 ? 120 : x === 8 || y === 8 ? 190 : 245);
      break;
    case 'dots':
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const d = Math.hypot(x + 0.5 - w / 2, y + 0.5 - h / 2);
        const cover = Math.max(0, Math.min(1, 3.5 - d)); // anti-aliased dot of radius 3
        grey(x, y, 240 - cover * 190);
      }
      break;
    case 'bricks':
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const row = y < 8 ? 0 : 1;
        const bx = (x + row * 16) % 32;
        const mortar = y % 8 === 7 || bx === 31;
        const tone = (rnd() - 0.5) * 18;
        if (mortar) put(x, y, 205 + tone / 2, 200 + tone / 2, 190 + tone / 2);
        else put(x, y, 160 + tone + (row ? 10 : 0), 70 + tone / 2, 50 + tone / 2);
      }
      break;
    case 'weave':
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        // strips 4 px wide; over / under alternates every strip
        const sx = Math.floor(x / 4), sy = Math.floor(y / 4);
        const horizontal = (sx + sy) % 2 === 0;
        const t = horizontal ? (y % 4) / 3 : (x % 4) / 3;
        const shade = 1 - Math.abs(t - 0.5) * 0.6;
        put(x, y, (horizontal ? 200 : 170) * shade, (horizontal ? 180 : 150) * shade, (horizontal ? 140 : 110) * shade);
      }
      break;
    case 'noise':
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) grey(x, y, 128 + (rnd() - 0.5) * 160);
      break;
    case 'clouds': {
      const n = fractal(4, 5, 17);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const v = n(x / w, y / h);
        put(x, y, 70 + v * 185, 120 + v * 135, 200 + v * 55);
      }
      break;
    }
    case 'wood': {
      const n = fractal(2, 3, 29);
      const fine = wrapNoise(32, 5);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        // rings along x, bent by noise; whole periods across the tile keep it seamless
        const ring = (x / w) * 6 + n(x / w, y / h) * 2.5;
        const f = ring - Math.floor(ring);
        const v = 0.55 + 0.45 * Math.pow(Math.sin(f * Math.PI), 0.6);
        const grain = (fine(x / w, y / h) - 0.5) * 0.12;
        put(x, y, (176 + 60 * grain) * (v + grain), (112 + 40 * grain) * (v + grain), 62 * (v + grain));
      }
      break;
    }
    case 'burlap': {
      const n = wrapNoise(16, 41);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const thread = Math.min(Math.abs(Math.sin((x / w) * Math.PI * 16)), Math.abs(Math.sin((y / h) * Math.PI * 16)));
        const v = 0.6 + 0.3 * thread + (n(x / w, y / h) - 0.5) * 0.3;
        put(x, y, 196 * v, 168 * v, 122 * v);
      }
      break;
    }
    case 'water': {
      const n = fractal(3, 4, 53);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const u = x / w, v = y / h;
        const ripple = Math.sin((v * 8 + n(u, v) * 3) * Math.PI * 2) * 0.5 + 0.5;
        const lit = Math.pow(ripple, 3);
        put(x, y, 30 + lit * 150, 90 + lit * 140, 150 + lit * 100);
      }
      break;
    }
    case 'grass': {
      const n = fractal(6, 3, 67);
      const blades = wrapNoise(48, 71, 4); // narrow in x, long in y: blades
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const u = x / w, v = y / h;
        const b = blades(u, v);
        const v2 = 0.45 + 0.35 * n(u, v) + 0.3 * Math.pow(b, 3);
        put(x, y, 60 * v2, 150 * v2 + 20, 45 * v2);
      }
      break;
    }
    default:
      return null;
  }
  return { width: w, height: h, data };
}

/** The `patterns` kind's built-in presets ({ id, name, group, data }) and groups. */
export function patternBuiltins() {
  return {
    groups: BUILTIN_GROUPS.map((g) => ({ ...g, parent: null })),
    presets: BUILTIN_PATTERNS.map(([id, name, group, width, height]) => ({ id, name, group, data: { width, height, builtin: id, mode: 'rgb' } })),
  };
}
