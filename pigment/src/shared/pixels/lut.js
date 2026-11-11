// Colour lookup tables (builder "adjust-more"): parsers for .cube (Adobe/Resolve, 1D and 3D), .3dl
// (Autodesk Lustre/Flame), .look (Adobe SpeedGrade) and .csp (Rising Sun cineSpace), writers for
// .cube and .3dl, the interpolating apply used by the Color Lookup adjustment, and the built-in
// presets (generated in code: approximations that carry Photoshop's preset names, not copies of
// its files). Pure, no DOM.
//
// A table is plain data so it survives JSON (adjustment layer params, .pigment, actions):
//   { type: '3d', size: N, data: number[N*N*N*3], title?, domainMin?: [r, g, b], domainMax?: [r, g, b] }
//       RGB triples 0..1, red fastest: index = (r + g*N + b*N*N) * 3 (the .cube order)
//   { type: '1d', size: N, data: number[N*3], ... }   one RGB triple per input step
// `data` may also be a Float32Array (the presets, tables built in code).

import { clampRect } from './core.js';

/** @typedef {import('./core.js').ImageDataLike} ImageDataLike */
/** @typedef {import('./core.js').Rect} Rect */
/** @typedef {{ type: '3d'|'1d', size: number, data: number[]|Float32Array, title?: string, domainMin?: number[], domainMax?: number[] }} Lut */

const MAX_3D = 256, MAX_1D = 65536;

const fail = (msg) => {
  throw new Error(msg);
};

/** True when v looks like a usable table (right type, size and data length). */
export function isLut(v) {
  if (!v || typeof v !== 'object' || !(Array.isArray(v.data) || v.data instanceof Float32Array)) return false;
  const n = v.size;
  if (!Number.isInteger(n) || n < 2) return false;
  if (v.type === '3d') return n <= MAX_3D && v.data.length === n * n * n * 3;
  if (v.type === '1d') return n <= MAX_1D && v.data.length === n * 3;
  return false;
}

/** Builds a 3D table by evaluating fn(r, g, b) -> [r, g, b] (all 0..1) on the lattice. */
export function makeLut3d(size, fn, title = '') {
  const n = Math.max(2, Math.min(MAX_3D, Math.round(size)));
  const data = new Float32Array(n * n * n * 3);
  let i = 0;
  for (let b = 0; b < n; b++) for (let g = 0; g < n; g++) for (let r = 0; r < n; r++, i += 3) {
    const o = fn(r / (n - 1), g / (n - 1), b / (n - 1));
    data[i] = o[0];
    data[i + 1] = o[1];
    data[i + 2] = o[2];
  }
  return { type: '3d', size: n, data, title };
}

export const identityLut3d = (size = 17) => makeLut3d(size, (r, g, b) => [r, g, b], 'Identity');

/**
 * Plain-data copy of a table for storage in params: numbers rounded to `digits` decimals (JSON stays
 * compact; 6 decimals are finer than 16 bits) and typed arrays turned into arrays.
 */
export function compactLut(lut, digits = 6) {
  if (!isLut(lut)) return null;
  const k = 10 ** digits;
  const data = new Array(lut.data.length);
  for (let i = 0; i < data.length; i++) data[i] = Math.round(lut.data[i] * k) / k;
  const out = { type: lut.type, size: lut.size, data };
  if (lut.title) out.title = String(lut.title);
  if (lut.domainMin) out.domainMin = [+lut.domainMin[0], +lut.domainMin[1], +lut.domainMin[2]];
  if (lut.domainMax) out.domainMax = [+lut.domainMax[0], +lut.domainMax[1], +lut.domainMax[2]];
  return out;
}

// ---------------------------------------------------------------------------------------------
// Compiled form (typed data, input scaling) cached per table object

const COMPILED = new WeakMap();

function compile(lut) {
  let c = COMPILED.get(lut);
  if (c && c.length === lut.data.length) return c;
  const data = lut.data instanceof Float32Array ? lut.data : Float32Array.from(lut.data);
  const min = [0, 0, 0], max = [1, 1, 1];
  for (let k = 0; k < 3; k++) {
    const lo = Number(lut.domainMin?.[k]), hi = Number(lut.domainMax?.[k]);
    if (Number.isFinite(lo) && Number.isFinite(hi) && hi > lo) {
      min[k] = lo;
      max[k] = hi;
    }
  }
  c = { type: lut.type, size: lut.size, data, min, max, length: lut.data.length };
  COMPILED.set(lut, c);
  return c;
}

/** Position of an input 0..1 on a table axis: [index of the lower lattice point, fraction]. */
function axisPos(v, lo, hi, n, out) {
  let t = ((v - lo) / (hi - lo)) * (n - 1);
  if (!(t > 0)) t = 0;
  else if (t > n - 1) t = n - 1;
  let i = Math.floor(t);
  if (i >= n - 1) i = n - 2;
  out[0] = i;
  out[1] = t - i;
}

const POS = [0, 0];

/**
 * One colour through a table: r, g, b in 0..1 -> [r, g, b] (not clamped). Trilinear for 3D tables,
 * linear per channel for 1D tables.
 * @param {Lut} lut
 */
export function sampleLut(lut, r, g, b) {
  const c = compile(lut), T = c.data, n = c.size;
  if (c.type === '1d') {
    const out = [0, 0, 0], v = [r, g, b];
    for (let k = 0; k < 3; k++) {
      axisPos(v[k], c.min[k], c.max[k], n, POS);
      const i = POS[0] * 3 + k;
      out[k] = T[i] + (T[i + 3] - T[i]) * POS[1];
    }
    return out;
  }
  axisPos(r, c.min[0], c.max[0], n, POS);
  const x = POS[0], fx = POS[1];
  axisPos(g, c.min[1], c.max[1], n, POS);
  const y = POS[0], fy = POS[1];
  axisPos(b, c.min[2], c.max[2], n, POS);
  const z = POS[0], fz = POS[1];
  const dy = n * 3, dz = n * n * 3;
  const base = (x + y * n + z * n * n) * 3;
  const out = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    const i = base + k;
    const c00 = T[i] + (T[i + 3] - T[i]) * fx;
    const c10 = T[i + dy] + (T[i + dy + 3] - T[i + dy]) * fx;
    const c01 = T[i + dz] + (T[i + dz + 3] - T[i + dz]) * fx;
    const c11 = T[i + dz + dy] + (T[i + dz + dy + 3] - T[i + dz + dy]) * fx;
    const c0 = c00 + (c10 - c00) * fy, c1 = c01 + (c11 - c01) * fy;
    out[k] = c0 + (c1 - c0) * fz;
  }
  return out;
}

/** A 3D table of another grid size holding the same mapping over 0..1 (also turns 1D tables into 3D). */
export function resampleLut(lut, size) {
  const out = makeLut3d(size, (r, g, b) => sampleLut(lut, r, g, b), lut.title ?? '');
  return out;
}

/** Position-stable noise in [-0.49, 0.49): breaks up banding without moving values that sit exactly on a level. */
function ditherNoise(x, y) {
  let h = Math.imul(x + 0x9e3779b9, 0x85ebca6b) ^ Math.imul(y + 0x7f4a7c15, 0xc2b2ae35);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  return ((h >>> 8) / 16777216 - 0.5) * 0.98;
}

/**
 * Maps the RGB of img through a table in place (alpha untouched) and returns img. 3D tables are
 * interpolated trilinearly, 1D tables linearly per channel; inputs outside the table's domain clamp
 * to its edge. `dither` adds less than half a level of position-stable noise before rounding, which
 * hides the banding a steep table leaves in 8-bit gradients.
 * @param {ImageDataLike} img
 * @param {Lut} lut
 * @param {{ dither?: boolean }} [options]
 * @param {Rect | null} [rect]
 */
export function applyLut3d(img, lut, { dither = false } = {}, rect = null) {
  if (!isLut(lut)) return img;
  const r = clampRect(rect, img.width, img.height);
  if (r.width <= 0 || r.height <= 0) return img;
  const c = compile(lut), T = c.data, n = c.size;
  const d = img.data, w = img.width;
  if (c.type === '1d') {
    // 8-bit inputs: the whole mapping is three 256-entry float tables
    const tabs = [new Float32Array(256), new Float32Array(256), new Float32Array(256)];
    for (let k = 0; k < 3; k++) for (let v = 0; v < 256; v++) {
      axisPos(v / 255, c.min[k], c.max[k], n, POS);
      const i = POS[0] * 3 + k;
      tabs[k][v] = (T[i] + (T[i + 3] - T[i]) * POS[1]) * 255;
    }
    const [tr, tg, tb] = tabs;
    for (let y = r.y, ye = r.y + r.height; y < ye; y++) {
      let i = (y * w + r.x) * 4;
      for (let x = r.x, xe = r.x + r.width; x < xe; x++, i += 4) {
        const e = dither ? ditherNoise(x, y) : 0;
        // Uint8ClampedArray assignment rounds to nearest and clamps
        d[i] = tr[d[i]] + e;
        d[i + 1] = tg[d[i + 1]] + e;
        d[i + 2] = tb[d[i + 2]] + e;
      }
    }
    return img;
  }
  // per-channel 8-bit -> (lattice offset, fraction) tables
  const offs = [new Int32Array(256), new Int32Array(256), new Int32Array(256)];
  const fracs = [new Float32Array(256), new Float32Array(256), new Float32Array(256)];
  const stride = [3, n * 3, n * n * 3];
  for (let k = 0; k < 3; k++) for (let v = 0; v < 256; v++) {
    axisPos(v / 255, c.min[k], c.max[k], n, POS);
    offs[k][v] = POS[0] * stride[k];
    fracs[k][v] = POS[1];
  }
  const [ox, oy, oz] = offs, [fxs, fys, fzs] = fracs;
  const dy = stride[1], dz = stride[2];
  for (let y = r.y, ye = r.y + r.height; y < ye; y++) {
    let i = (y * w + r.x) * 4;
    for (let x = r.x, xe = r.x + r.width; x < xe; x++, i += 4) {
      const R = d[i], G = d[i + 1], B = d[i + 2];
      const p = ox[R] + oy[G] + oz[B];
      const fx = fxs[R], fy = fys[G], fz = fzs[B];
      const e = dither ? ditherNoise(x, y) : 0;
      // trilinear: four lerps along red, two along green, one along blue (per output channel)
      let a = T[p], b = T[p + dy], cc = T[p + dz], dd = T[p + dz + dy];
      let c00 = a + (T[p + 3] - a) * fx, c10 = b + (T[p + dy + 3] - b) * fx;
      let c01 = cc + (T[p + dz + 3] - cc) * fx, c11 = dd + (T[p + dz + dy + 3] - dd) * fx;
      let c0 = c00 + (c10 - c00) * fy, c1 = c01 + (c11 - c01) * fy;
      d[i] = (c0 + (c1 - c0) * fz) * 255 + e; // Uint8ClampedArray assignment rounds to nearest and clamps
      a = T[p + 1]; b = T[p + dy + 1]; cc = T[p + dz + 1]; dd = T[p + dz + dy + 1];
      c00 = a + (T[p + 4] - a) * fx; c10 = b + (T[p + dy + 4] - b) * fx;
      c01 = cc + (T[p + dz + 4] - cc) * fx; c11 = dd + (T[p + dz + dy + 4] - dd) * fx;
      c0 = c00 + (c10 - c00) * fy; c1 = c01 + (c11 - c01) * fy;
      d[i + 1] = (c0 + (c1 - c0) * fz) * 255 + e;
      a = T[p + 2]; b = T[p + dy + 2]; cc = T[p + dz + 2]; dd = T[p + dz + dy + 2];
      c00 = a + (T[p + 5] - a) * fx; c10 = b + (T[p + dy + 5] - b) * fx;
      c01 = cc + (T[p + dz + 5] - cc) * fx; c11 = dd + (T[p + dz + dy + 5] - dd) * fx;
      c0 = c00 + (c10 - c00) * fy; c1 = c01 + (c11 - c01) * fy;
      d[i + 2] = (c0 + (c1 - c0) * fz) * 255 + e;
    }
  }
  return img;
}
