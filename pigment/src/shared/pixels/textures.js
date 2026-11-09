// Procedural textures and relief lighting shared by the Filter Gallery effects (Rough Pastels,
// Underpainting, Texturizer, Conté Crayon, Glass) and the Sketch kinds (builder "gallery-b" owns and
// refines this file; this seed gives every table a working import from day one). texture() returns
// a height map (0..255 grey, Uint8ClampedArray of width*height); relief() lights an image by one.
// Deterministic for a seed; `scaling` is a percentage like Photoshop's (100 = native size).

import { randomSeeded } from './core.js';

export const TEXTURE_NAMES = ['canvas', 'brick', 'burlap', 'sandstone', 'frosted', 'blocks', 'tiny-lens'];

/** Value noise on a lattice of `cell` px, bilinear between lattice points, 0..1. */
function valueNoise(width, height, cell, seed) {
  const rnd = randomSeeded(seed);
  const gw = Math.ceil(width / cell) + 2, gh = Math.ceil(height / cell) + 2;
  const g = new Float32Array(gw * gh);
  for (let i = 0; i < g.length; i++) g[i] = rnd();
  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    const fy = y / cell, y0 = fy | 0, ty = fy - y0;
    for (let x = 0; x < width; x++) {
      const fx = x / cell, x0 = fx | 0, tx = fx - x0;
      const a = g[y0 * gw + x0], b = g[y0 * gw + x0 + 1], c = g[(y0 + 1) * gw + x0], d = g[(y0 + 1) * gw + x0 + 1];
      out[y * width + x] = (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
    }
  }
  return out;
}

/**
 * @param {string} name one of TEXTURE_NAMES
 * @param {number} width
 * @param {number} height
 * @param {{ scaling?: number, seed?: number }} [opts] scaling 50..200 (%), seed for the noise
 * @returns {Uint8ClampedArray} height map, width*height, 0..255
 */
export function texture(name, width, height, { scaling = 100, seed = 1 } = {}) {
  const s = Math.max(0.25, Math.min(4, (Number(scaling) || 100) / 100));
  const out = new Uint8ClampedArray(width * height);
  const fine = valueNoise(width, height, Math.max(1, 2 * s), seed + 11);
  const coarse = valueNoise(width, height, Math.max(2, 9 * s), seed + 23);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      let v;
      switch (name) {
        case 'brick': {
          // staggered rows of bricks with darker mortar lines
          const bw = 32 * s, bh = 14 * s, m = Math.max(1, 1.5 * s);
          const row = Math.floor(y / bh);
          const xx = x + (row % 2 ? bw / 2 : 0);
          const inMortar = xx % bw < m || y % bh < m;
          v = inMortar ? 0.2 : 0.65 + 0.3 * (fine[i] - 0.5) + 0.1 * (coarse[i] - 0.5);
          break;
        }
        case 'burlap': {
          // coarse plain weave: two crossing thread directions
          const p = 6 * s;
          const u = Math.sin((x / p) * Math.PI), w = Math.sin((y / p) * Math.PI);
          v = 0.5 + 0.22 * (Math.abs(u) - Math.abs(w)) + 0.2 * (fine[i] - 0.5);
          break;
        }
        case 'canvas': {
          const p = 3 * s;
          const u = Math.sin((x / p) * Math.PI), w = Math.sin((y / p) * Math.PI);
          v = 0.5 + 0.14 * (Math.abs(u) - Math.abs(w)) + 0.12 * (fine[i] - 0.5) + 0.08 * (coarse[i] - 0.5);
          break;
        }
        case 'frosted':
          v = 0.3 + 0.4 * coarse[i] + 0.3 * fine[i];
          break;
        case 'blocks': {
          // random block heights on a grid
          const b = 12 * s;
          const bx = Math.floor(x / b), by = Math.floor(y / b);
          const rnd = randomSeeded(seed * 7919 + bx * 131 + by * 17);
          v = 0.25 + 0.5 * rnd() + 0.1 * (fine[i] - 0.5);
          break;
        }
        case 'tiny-lens': {
          // array of small bumps (spherical caps)
          const p = 8 * s;
          const dx = ((x % p) / p) * 2 - 1, dy = ((y % p) / p) * 2 - 1;
          const r2 = dx * dx + dy * dy;
          v = r2 < 1 ? 0.3 + 0.7 * Math.sqrt(1 - r2) : 0.3;
          break;
        }
        default: // sandstone
          v = 0.45 + 0.35 * (coarse[i] - 0.5) + 0.45 * (fine[i] - 0.5);
      }
      out[i] = v <= 0 ? 0 : v >= 1 ? 255 : (v * 255 + 0.5) | 0;
    }
  }
  return out;
}

const DIRECTIONS = { top: [0, -1], 'top-left': [-0.7071, -0.7071], left: [-1, 0], 'bottom-left': [-0.7071, 0.7071], bottom: [0, 1], 'bottom-right': [0.7071, 0.7071], right: [1, 0], 'top-right': [0.7071, -0.7071] };

/**
 * Lights img (in place, RGB only) by a height map: the slope facing the light brightens, the slope
 * away darkens. relief 0..50 scales the effect (Photoshop's range), lightDirection names the side the
 * light comes from, invert flips the height map. The map must be img.width*img.height long.
 */
export function relief(img, height, { relief: amount = 4, lightDirection = 'top', invert = false, rect = null } = {}) {
  const w = img.width, h = img.height, d = img.data;
  const [lx, ly] = DIRECTIONS[lightDirection] ?? DIRECTIONS.top;
  const k = (Math.max(0, Math.min(50, Number(amount) || 0)) / 50) * 1.6;
  const x0 = rect ? Math.max(0, rect.x) : 0, y0 = rect ? Math.max(0, rect.y) : 0;
  const x1 = rect ? Math.min(w, rect.x + rect.width) : w, y1 = rect ? Math.min(h, rect.y + rect.height) : h;
  const at = (x, y) => {
    const v = height[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))] / 255;
    return invert ? 1 - v : v;
  };
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const gx = at(x + 1, y) - at(x - 1, y), gy = at(x, y + 1) - at(x, y - 1);
      // light arrives from the named side: a slope rising towards it faces the light
      const shade = 1 + k * (gx * -lx + gy * -ly) * 2;
      const i = (y * w + x) * 4;
      d[i] = Math.max(0, Math.min(255, d[i] * shade));
      d[i + 1] = Math.max(0, Math.min(255, d[i + 1] * shade));
      d[i + 2] = Math.max(0, Math.min(255, d[i + 2] * shade));
    }
  }
  return img;
}
