// Procedural textures and relief lighting shared by the Filter Gallery effects (Rough Pastels,
// Underpainting, Texturizer, Conté Crayon, Glass) and the Sketch kinds (builder "gallery-b" owns this
// file). texture() returns a height map (0..255 grey, Uint8ClampedArray of width*height); relief()
// lights an image by one. Deterministic for a seed; `scaling` is a percentage like Photoshop's
// (100 = native size, 50..200 in the dialogs). Nothing here reads the DOM.
//
// The seven textures follow Photoshop's presets:
// - canvas: a fine plain weave (threads about 3 px wide at 100%), each thread slightly uneven;
// - burlap: the same weave twice as coarse with wobblier, hairier threads;
// - brick: running-bond bricks (32 x 14 px) with recessed mortar, a tone per brick and pitting;
// - sandstone: smooth fractal noise with fine sharp grains;
// - frosted (Glass): dense fractal bumps, like frosted glass;
// - blocks (Glass): random rectangular glass blocks, each bevelled, with a random height;
// - tiny-lens (Glass): a square array of spherical lens caps.
// Beyond the maps there are two helpers the effects share: heightFromImage() turns a loaded
// texture file (Texturizer's "Load Texture…") into a tiled height map, smoothHeight() blurs a map
// (Glass's Smoothness) and heightGradient() gives the slope Glass refracts by.

import { randomSeeded } from './core.js';

export const TEXTURE_NAMES = ['canvas', 'brick', 'burlap', 'sandstone', 'frosted', 'blocks', 'tiny-lens'];

/** Integer hash of three int32s to 0..1 (position-stable noise, cell jitter). */
function hash3(x, y, z) {
  let h = (Math.imul(x | 0, 0x27d4eb2d) + Math.imul(y | 0, 0x165667b1) + Math.imul(z | 0, 0x9e3779b1)) | 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/** Value noise on a lattice of `cell` px, smooth (Hermite) between lattice points, 0..1. Position stable. */
function valueNoise(width, height, cell, seed) {
  const out = new Float32Array(width * height);
  const inv = 1 / cell;
  for (let y = 0; y < height; y++) {
    const fy = y * inv, y0 = Math.floor(fy);
    let ty = fy - y0;
    ty = ty * ty * (3 - 2 * ty);
    for (let x = 0; x < width; x++) {
      const fx = x * inv, x0 = Math.floor(fx);
      let tx = fx - x0;
      tx = tx * tx * (3 - 2 * tx);
      const a = hash3(x0, y0, seed), b = hash3(x0 + 1, y0, seed), c = hash3(x0, y0 + 1, seed), d = hash3(x0 + 1, y0 + 1, seed);
      out[y * width + x] = (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
    }
  }
  return out;
}

/** Fractal (fBm) value noise: `octaves` layers, each half the cell and `gain` the amplitude, normalised to 0..1. */
function fractalNoise(width, height, cell, seed, octaves = 4, gain = 0.5) {
  const out = new Float32Array(width * height);
  let amp = 1, total = 0, c = cell;
  for (let o = 0; o < octaves && c >= 1; o++) {
    const n = valueNoise(width, height, c, seed + o * 101);
    for (let i = 0; i < out.length; i++) out[i] += n[i] * amp;
    total += amp;
    amp *= gain;
    c /= 2;
  }
  const inv = total > 0 ? 1 / total : 1;
  for (let i = 0; i < out.length; i++) out[i] *= inv;
  return out;
}

/**
 * Plain weave: warp threads (vertical) and weft threads (horizontal) of pitch `p` alternate over
 * and under each other; `wobble` bends the threads, `hair` adds fibre noise. Returns 0..1.
 */
function weave(width, height, p, seed, { wobble = 0.15, hair = 0.12, gap = 0.12 } = {}) {
  const out = new Float32Array(width * height);
  const bend = valueNoise(width, height, Math.max(2, p * 4), seed + 3);
  const fibre = valueNoise(width, height, Math.max(1, p / 3), seed + 5);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const w = (bend[i] - 0.5) * wobble * p;
      // position inside the current thread (0..1 across its width) for both directions
      const fx = (x + w) / p, fy = (y - w) / p;
      const cx = Math.floor(fx), cy = Math.floor(fy);
      const ux = fx - cx, uy = fy - cy;
      // a thread is a half cylinder: tall in the middle, falling towards the gap between threads
      const px = Math.max(0, 1 - Math.abs(ux - 0.5) * 2 / (1 - gap));
      const py = Math.max(0, 1 - Math.abs(uy - 0.5) * 2 / (1 - gap));
      const warpH = Math.sqrt(px), weftH = Math.sqrt(py);
      // checkerboard over/under: the thread on top is the one seen
      const warpOnTop = ((cx + cy) & 1) === 0;
      let v = warpOnTop ? Math.max(warpH, weftH * 0.7) : Math.max(weftH, warpH * 0.7);
      v = 0.15 + 0.7 * v + hair * (fibre[i] - 0.5);
      out[i] = v;
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
  const sd = (Number(seed) | 0) || 1;
  const out = new Uint8ClampedArray(width * height);
  const n = width * height;
  const store = (v, i) => { out[i] = v <= 0 ? 0 : v >= 1 ? 255 : (v * 255 + 0.5) | 0; };
  switch (name) {
    case 'canvas': {
      const w = weave(width, height, Math.max(2, 3 * s), sd, { wobble: 0.1, hair: 0.1, gap: 0.1 });
      for (let i = 0; i < n; i++) store(w[i], i);
      break;
    }
    case 'burlap': {
      const w = weave(width, height, Math.max(3, 6.5 * s), sd, { wobble: 0.3, hair: 0.22, gap: 0.22 });
      for (let i = 0; i < n; i++) store(w[i], i);
      break;
    }
    case 'brick': {
      // running bond: every other course shifted by half a brick; mortar is recessed and rough
      const bw = 32 * s, bh = 14 * s, m = Math.max(1, 1.6 * s);
      const pits = fractalNoise(width, height, Math.max(1, 2.5 * s), sd + 7, 3);
      const mortar = valueNoise(width, height, Math.max(1, 1.5 * s), sd + 9);
      for (let y = 0; y < height; y++) {
        const row = Math.floor(y / bh);
        const yy = y - row * bh;
        for (let x = 0; x < width; x++) {
          const i = y * width + x;
          const xs = x + (row & 1 ? bw / 2 : 0);
          const col = Math.floor(xs / bw);
          const xx = xs - col * bw;
          if (xx < m || yy < m) {
            store(0.12 + 0.12 * mortar[i], i);
            continue;
          }
          // each brick has its own tone, a soft bevel towards the mortar and a pitted face
          const tone = 0.55 + 0.3 * hash3(col, row, sd);
          const ex = Math.min(xx - m, bw - xx), ey = Math.min(yy - m, bh - yy);
          const bevel = Math.min(1, Math.min(ex, ey) / (1.5 * s + 0.5));
          store(tone * (0.6 + 0.4 * bevel) + 0.18 * (pits[i] - 0.5), i);
        }
      }
      break;
    }
    case 'sandstone': {
      // slow undulation with fine, sharp grains on top
      const base = fractalNoise(width, height, Math.max(2, 10 * s), sd + 11, 4, 0.55);
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const i = y * width + x;
        const grain = hash3(Math.floor(x / Math.max(1, s)), Math.floor(y / Math.max(1, s)), sd + 13);
        store(0.2 + 0.5 * base[i] + 0.3 * grain * grain, i);
      }
      break;
    }
    case 'frosted': {
      // dense bumps: fractal noise with a short cell, slightly contrast stretched
      const f = fractalNoise(width, height, Math.max(1.5, 4 * s), sd + 17, 4, 0.6);
      for (let i = 0; i < n; i++) store(0.5 + (f[i] - 0.5) * 1.8, i);
      break;
    }
    case 'blocks': {
      // random glass blocks: a jittered grid of rectangles, each a bevelled slab at a random height
      const cell = Math.max(3, 12 * s);
      const bevelW = Math.max(1, 2 * s);
      for (let y = 0; y < height; y++) {
        const gy = Math.floor(y / cell);
        for (let x = 0; x < width; x++) {
          const gx = Math.floor(x / cell);
          // each column of blocks is shifted vertically by a per-column offset so edges do not line up
          const shift = (hash3(gx, 0, sd + 19) - 0.5) * cell;
          const by = Math.floor((y + shift) / cell);
          const yy = (y + shift) - by * cell, xx = x - gx * cell;
          const h = 0.3 + 0.6 * hash3(gx, by, sd + 23);
          const edge = Math.min(xx, cell - 1 - xx, yy, cell - 1 - yy);
          const bevel = Math.min(1, Math.max(0, edge) / bevelW);
          store(h * (0.55 + 0.45 * bevel) + 0.04 * (hash3(x, y, sd + 29) - 0.5), y * width + x);
        }
        void gy;
      }
      break;
    }
    case 'tiny-lens': {
      // square array of spherical caps sitting on a flat plate
      const p = Math.max(3, 8 * s);
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const dx = ((x % p) / p) * 2 - 1 + 1 / p, dy = ((y % p) / p) * 2 - 1 + 1 / p;
        const r2 = dx * dx + dy * dy;
        store(r2 < 1 ? 0.25 + 0.75 * Math.sqrt(1 - r2) : 0.25, y * width + x);
      }
      break;
    }
    default: {
      // unknown name: sandstone-like noise so callers always get a usable map
      const base = fractalNoise(width, height, Math.max(2, 10 * s), sd + 11, 4, 0.55);
      for (let i = 0; i < n; i++) store(0.2 + 0.6 * base[i], i);
    }
  }
  return out;
}

/**
 * A height map from a loaded texture image (Texturizer's "Load Texture…"): the image's luminance,
 * scaled by `scaling` % and tiled over width x height (Photoshop tiles a texture smaller than the
 * image). Transparent pixels count as dark.
 * @param {{ width: number, height: number, data: ArrayLike<number> }} img
 */
export function heightFromImage(img, width, height, { scaling = 100 } = {}) {
  const out = new Uint8ClampedArray(width * height);
  if (!img || !img.width || !img.height || !img.data) return out;
  const s = Math.max(0.25, Math.min(4, (Number(scaling) || 100) / 100));
  const tw = img.width * s, th = img.height * s;
  const d = img.data, iw = img.width, ih = img.height;
  for (let y = 0; y < height; y++) {
    let sy = Math.floor(((y % th) + th) % th / s);
    if (sy >= ih) sy = ih - 1;
    for (let x = 0; x < width; x++) {
      let sx = Math.floor(((x % tw) + tw) % tw / s);
      if (sx >= iw) sx = iw - 1;
      const p = (sy * iw + sx) * 4;
      const lum = (d[p] * 299 + d[p + 1] * 587 + d[p + 2] * 114) / 1000;
      out[y * width + x] = (lum * d[p + 3]) / 255 + 0.5;
    }
  }
  return out;
}

/** Box blurs a height map (0..255) in place by `radius` px, three passes (≈ Gaussian); edges replicate. */
export function smoothHeight(map, width, height, radius) {
  const r = Math.round(Number(radius) || 0);
  if (r <= 0) return map;
  const a = new Float32Array(map.length);
  for (let i = 0; i < map.length; i++) a[i] = map[i];
  const b = new Float32Array(map.length);
  const inv = 1 / (2 * r + 1);
  for (let pass = 0; pass < 3; pass++) {
    // horizontal
    for (let y = 0; y < height; y++) {
      const row = y * width;
      let sum = 0;
      for (let k = -r; k <= r; k++) sum += a[row + Math.min(width - 1, Math.max(0, k))];
      for (let x = 0; x < width; x++) {
        b[row + x] = sum * inv;
        sum += a[row + Math.min(width - 1, x + r + 1)] - a[row + Math.max(0, x - r)];
      }
    }
    // vertical
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let k = -r; k <= r; k++) sum += b[Math.min(height - 1, Math.max(0, k)) * width + x];
      for (let y = 0; y < height; y++) {
        a[y * width + x] = sum * inv;
        sum += b[Math.min(height - 1, y + r + 1) * width + x] - b[Math.max(0, y - r) * width + x];
      }
    }
  }
  for (let i = 0; i < map.length; i++) map[i] = a[i] + 0.5;
  return map;
}

/**
 * Central-difference slope of a height map at (x, y): [dh/dx, dh/dy] in height units (0..1) per px,
 * edges replicated. Glass refracts by this; relief() lights by it.
 */
export function heightGradient(map, width, height, x, y, out = [0, 0]) {
  const xl = x > 0 ? x - 1 : 0, xr = x < width - 1 ? x + 1 : width - 1;
  const yu = y > 0 ? y - 1 : 0, yd = y < height - 1 ? y + 1 : height - 1;
  out[0] = (map[y * width + xr] - map[y * width + xl]) / 510;
  out[1] = (map[yd * width + x] - map[yu * width + x]) / 510;
  return out;
}

const DIRECTIONS = { top: [0, -1], 'top-left': [-0.7071, -0.7071], left: [-1, 0], 'bottom-left': [-0.7071, 0.7071], bottom: [0, 1], 'bottom-right': [0.7071, 0.7071], right: [1, 0], 'top-right': [0.7071, -0.7071] };
export const LIGHT_DIRECTIONS = Object.freeze(Object.keys(DIRECTIONS));

/**
 * Lights img (in place, RGB only) by a height map: the slope facing the light brightens, the slope
 * away darkens. relief 0..50 scales the effect (Photoshop's range), lightDirection names the side the
 * light comes from, invert flips the height map. The map must be img.width*img.height long; rect
 * limits which pixels are written.
 */
export function relief(img, height, { relief: amount = 4, lightDirection = 'top', invert = false, rect = null } = {}) {
  const w = img.width, h = img.height, d = img.data;
  const [lx, ly] = DIRECTIONS[lightDirection] ?? DIRECTIONS.top;
  const k = (Math.max(0, Math.min(50, Number(amount) || 0)) / 50) * 1.6 * (invert ? -1 : 1);
  const x0 = rect ? Math.max(0, rect.x) : 0, y0 = rect ? Math.max(0, rect.y) : 0;
  const x1 = rect ? Math.min(w, rect.x + rect.width) : w, y1 = rect ? Math.min(h, rect.y + rect.height) : h;
  if (height.length < w * h) return img;
  for (let y = y0; y < y1; y++) {
    const yu = (y > 0 ? y - 1 : 0) * w, yd = (y < h - 1 ? y + 1 : h - 1) * w, row = y * w;
    for (let x = x0; x < x1; x++) {
      const xl = x > 0 ? x - 1 : 0, xr = x < w - 1 ? x + 1 : w - 1;
      const gx = (height[row + xr] - height[row + xl]) / 255, gy = (height[yd + x] - height[yu + x]) / 255;
      // light arrives from the named side: a slope rising towards it faces the light
      const shade = 1 + k * (gx * -lx + gy * -ly) * 2;
      const i = (row + x) * 4;
      const r = d[i] * shade, g = d[i + 1] * shade, b = d[i + 2] * shade;
      d[i] = r < 0 ? 0 : r > 255 ? 255 : r;
      d[i + 1] = g < 0 ? 0 : g > 255 ? 255 : g;
      d[i + 2] = b < 0 ? 0 : b > 255 ? 255 : b;
    }
  }
  return img;
}
