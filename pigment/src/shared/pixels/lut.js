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

// ---------------------------------------------------------------------------------------------
// Parsers

const toText = (input) => (typeof input === 'string' ? input : new TextDecoder('utf-8').decode(input)).replace(/^﻿/, '');
/** A line that starts like a number (.cube keywords are words). */
const isNumberLine = (line) => /^[-+.\d]/.test(line);
/** A row of numbers only (.3dl: "3DMESH" starts with a digit but is a keyword). */
const isNumberRow = (line) => /^[-+.\d][-+.\deE\s,]*$/.test(line);
const numbers = (line) => line.split(/[\s,]+/).filter(Boolean).map(Number);

function checkSize(type, n) {
  if (!Number.isInteger(n) || n < 2 || n > (type === '3d' ? MAX_3D : MAX_1D)) fail(`Unsupported LUT size ${n}`);
}

function checkData(data, what) {
  for (let i = 0; i < data.length; i++) if (!Number.isFinite(data[i])) fail(`${what}: entry ${Math.floor(i / 3) + 1} is not a number`);
}

/**
 * Adobe / Resolve .cube: TITLE, LUT_1D_SIZE or LUT_3D_SIZE, DOMAIN_MIN / DOMAIN_MAX (or Resolve's
 * LUT_*_INPUT_RANGE lo hi), then one "r g b" row per entry with red changing fastest.
 * @param {string | Uint8Array} input @returns {Lut}
 */
export function parseCube(input) {
  const lines = toText(input).split(/\r?\n/);
  let title = '', type = null, size = 0;
  let domainMin = [0, 0, 0], domainMax = [1, 1, 1];
  const data = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line[0] === '#') continue;
    if (isNumberLine(line)) {
      const v = numbers(line);
      if (v.length < 3) fail('.cube: a data row needs three numbers');
      data.push(v[0], v[1], v[2]);
      continue;
    }
    const m = /^(\S+)\s*(.*)$/.exec(line);
    const key = m[1].toUpperCase(), rest = m[2].trim();
    if (key === 'TITLE') title = rest.replace(/^"(.*)"$/, '$1');
    else if (key === 'LUT_3D_SIZE' || key === 'LUT_1D_SIZE') {
      type = key === 'LUT_3D_SIZE' ? '3d' : '1d';
      size = Number(rest);
    } else if (key === 'DOMAIN_MIN' || key === 'DOMAIN_MAX') {
      const v = numbers(rest);
      if (v.length >= 3 && v.every(Number.isFinite)) {
        if (key === 'DOMAIN_MIN') domainMin = v.slice(0, 3);
        else domainMax = v.slice(0, 3);
      }
    } else if (key === 'LUT_3D_INPUT_RANGE' || key === 'LUT_1D_INPUT_RANGE') {
      const v = numbers(rest);
      if (v.length >= 2 && v[1] > v[0]) {
        domainMin = [v[0], v[0], v[0]];
        domainMax = [v[1], v[1], v[1]];
      }
    }
    // other keywords (LUT_IN_VIDEO_RANGE ...) do not change the table
  }
  if (!type) fail('.cube: LUT_3D_SIZE or LUT_1D_SIZE is missing');
  checkSize(type, size);
  const want = (type === '3d' ? size * size * size : size) * 3;
  if (data.length !== want) fail(`.cube: expected ${want / 3} rows, found ${data.length / 3}`);
  checkData(data, '.cube');
  return { type, size, data, title, domainMin, domainMax };
}

/**
 * Autodesk .3dl: an input ramp line (one value per lattice step), then size³ integer rows with BLUE
 * changing fastest. The output depth comes from a "Mesh <in> <out>" header when present, otherwise
 * from the largest value (rounded up to 8, 10, 12, 14 or 16 bits).
 * @param {string | Uint8Array} input @returns {Lut}
 */
export function parse3dl(input) {
  const lines = toText(input).split(/\r?\n/);
  let outBits = 0, title = '';
  const numeric = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line[0] === '#') {
      const t = /^#\s*TITLE\s*[:=]?\s*"?(.*?)"?$/i.exec(line);
      if (t && !title) title = t[1];
      continue;
    }
    if (!isNumberRow(line)) {
      const mesh = /^mesh\s+(\d+)\s+(\d+)/i.exec(line);
      if (mesh) outBits = Number(mesh[2]);
      continue; // 3DMESH, LUT8, gamma ... carry nothing the table needs
    }
    numeric.push(numbers(line));
  }
  // the first numeric line is the input ramp unless the file has none: a ramp either does not have three
  // values, or (a 3-point table) leaves a cube of rows behind it where the whole file would not be one
  const isCube = (c) => c > 0 && Math.round(Math.cbrt(c)) ** 3 === c;
  let ramp = null;
  if (numeric.length && (numeric[0].length !== 3 || (!isCube(numeric.length) && isCube(numeric.length - 1)))) ramp = numeric.shift();
  const rows = [];
  for (const v of numeric) {
    if (v.length < 3) fail('.3dl: a data row needs three numbers');
    rows.push(v[0], v[1], v[2]);
  }
  const count = rows.length / 3;
  const size = Math.round(Math.cbrt(count));
  if (size * size * size !== count) fail(`.3dl: ${count} rows do not form a cube`);
  checkSize('3d', size);
  if (ramp && ramp.length !== size) fail(`.3dl: the input ramp has ${ramp.length} steps but the table has ${size}`);
  checkData(rows, '.3dl');
  let max = 0;
  for (let i = 0; i < rows.length; i++) if (rows[i] > max) max = rows[i];
  if (!outBits) outBits = max <= 255 ? 8 : max <= 1023 ? 10 : max <= 4095 ? 12 : max <= 16383 ? 14 : 16;
  const scale = 2 ** outBits - 1;
  // file order is r slowest / b fastest; ours is r fastest
  const data = new Array(rows.length);
  for (let r = 0; r < size; r++) for (let g = 0; g < size; g++) for (let b = 0; b < size; b++) {
    const src = (r * size * size + g * size + b) * 3, dst = (r + g * size + b * size * size) * 3;
    data[dst] = rows[src] / scale;
    data[dst + 1] = rows[src + 1] / scale;
    data[dst + 2] = rows[src + 2] / scale;
  }
  return { type: '3d', size, data, title, domainMin: [0, 0, 0], domainMax: [1, 1, 1] };
}

/**
 * Adobe SpeedGrade .look: XML whose <LUT> element carries <size> and <data>. The data is either the
 * hex dump SpeedGrade writes (little-endian float32 RGB triples, red fastest) or plain numbers; a
 * .cube text wrapped in the XML (LUT_3D_SIZE … rows) is read as a .cube.
 * @param {string | Uint8Array} input @returns {Lut}
 */
export function parseLook(input) {
  const text = toText(input);
  const title = (/<look[^>]*\bname\s*=\s*"([^"]*)"/i.exec(text) ?? /<title>\s*"?([^<"]*)"?\s*<\/title>/i.exec(text))?.[1]?.trim() ?? '';
  if (/LUT_(3D|1D)_SIZE/i.test(text)) {
    // a .cube inside the XML (CDATA or element text): drop the tags and parse the rest
    const inner = text.replace(/<!\[CDATA\[|\]\]>/g, '\n').replace(/<[^>]*>/g, '\n');
    const lut = parseCube(inner);
    if (!lut.title) lut.title = title;
    return lut;
  }
  const strip = (s) => s.replace(/<!\[CDATA\[|\]\]>/g, '').replace(/["']/g, '').trim();
  const sizeM = /<size>([\s\S]*?)<\/size>/i.exec(text), dataM = /<data>([\s\S]*?)<\/data>/i.exec(text);
  if (!sizeM || !dataM) fail('.look: no <LUT> with <size> and <data> found');
  const size = Number(strip(sizeM[1]));
  checkSize('3d', size);
  const body = strip(dataM[1]);
  const want = size * size * size * 3;
  let data;
  if (/^[0-9a-fA-F\s]+$/.test(body) && body.replace(/\s+/g, '').length === want * 8) {
    const hex = body.replace(/\s+/g, '');
    const bytes = new Uint8Array(want * 4);
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
    const view = new DataView(bytes.buffer);
    data = new Array(want);
    for (let i = 0; i < want; i++) data[i] = view.getFloat32(i * 4, true);
  } else {
    data = numbers(body);
    if (data.length !== want) fail(`.look: expected ${want} values, found ${data.length}`);
  }
  checkData(data, '.look');
  return { type: '3d', size, data, title, domainMin: [0, 0, 0], domainMax: [1, 1, 1] };
}

/** Piecewise-linear lookup through (xs, ys), clamped at the ends. */
function shaper(xs, ys, v) {
  const n = xs.length;
  if (v <= xs[0]) return ys[0];
  if (v >= xs[n - 1]) return ys[n - 1];
  let k = 1;
  while (k < n - 1 && xs[k] < v) k++;
  const t = (v - xs[k - 1]) / (xs[k] - xs[k - 1] || 1);
  return ys[k - 1] + (ys[k] - ys[k - 1]) * t;
}

/**
 * Rising Sun cineSpace .csp: "CSPLUTV100", "3D" or "1D", an optional metadata block, three 1D
 * pre-LUTs (count, inputs, outputs) and the table ("N N N" then rows with red fastest, or a count
 * then rows for 1D). A linear pre-LUT becomes the table's input domain; any other shaper is baked
 * in by resampling the table over that domain (at least 33 points per axis).
 * @param {string | Uint8Array} input @returns {Lut}
 */
export function parseCsp(input) {
  const all = toText(input).split(/\r?\n/).map((l) => l.trim());
  const lines = [];
  let inMeta = false, title = '';
  for (const line of all) {
    if (/^BEGIN METADATA/i.test(line)) inMeta = true;
    else if (/^END METADATA/i.test(line)) inMeta = false;
    else if (inMeta) {
      if (!title && line) title = line.replace(/^"(.*)"$/, '$1');
    } else if (line && line[0] !== '#') lines.push(line);
  }
  if (!/^CSPLUTV100/i.test(lines[0] ?? '')) fail('.csp: missing CSPLUTV100 header');
  const kind = (lines[1] ?? '').toUpperCase();
  if (kind !== '3D' && kind !== '1D') fail('.csp: expected 3D or 1D');
  let at = 2;
  const pre = [];
  for (let k = 0; k < 3; k++) {
    const n = Number(lines[at++]);
    const xs = numbers(lines[at++] ?? ''), ys = numbers(lines[at++] ?? '');
    if (!Number.isInteger(n) || n < 2 || xs.length !== n || ys.length !== n) fail('.csp: malformed pre-LUT');
    pre.push({ xs, ys });
  }
  let lut;
  if (kind === '3D') {
    const dims = numbers(lines[at++] ?? '');
    if (dims.length !== 3 || dims[0] !== dims[1] || dims[1] !== dims[2]) fail('.csp: only cubic 3D tables are supported');
    const size = dims[0];
    checkSize('3d', size);
    const data = [];
    for (; at < lines.length; at++) {
      const v = numbers(lines[at]);
      if (v.length >= 3) data.push(v[0], v[1], v[2]);
    }
    if (data.length !== size * size * size * 3) fail(`.csp: expected ${size ** 3} rows, found ${data.length / 3}`);
    checkData(data, '.csp');
    lut = { type: '3d', size, data, title };
  } else {
    const size = Number(lines[at++]);
    checkSize('1d', size);
    const data = [];
    for (; at < lines.length; at++) {
      const v = numbers(lines[at]);
      if (v.length >= 3) data.push(v[0], v[1], v[2]);
    }
    if (data.length !== size * 3) fail(`.csp: expected ${size} rows, found ${data.length / 3}`);
    checkData(data, '.csp');
    lut = { type: '1d', size, data, title };
  }
  const domainMin = pre.map((p) => p.xs[0]), domainMax = pre.map((p) => p.xs[p.xs.length - 1]);
  // a pre-LUT that is one straight segment onto 0..1 only names the input domain
  const linear = pre.every((p) => {
    const n = p.xs.length, x0 = p.xs[0], x1 = p.xs[n - 1];
    if (!(x1 > x0)) return false;
    for (let i = 0; i < n; i++) if (Math.abs(p.ys[i] - (p.xs[i] - x0) / (x1 - x0)) > 1e-5) return false;
    return true;
  });
  if (linear) return { ...lut, domainMin, domainMax };
  const span = (k, t) => domainMin[k] + (domainMax[k] - domainMin[k]) * t;
  const through = (r, g, b) => sampleLut(lut, shaper(pre[0].xs, pre[0].ys, span(0, r)), shaper(pre[1].xs, pre[1].ys, span(1, g)), shaper(pre[2].xs, pre[2].ys, span(2, b)));
  if (lut.type === '3d') {
    const baked = makeLut3d(Math.min(65, Math.max(lut.size, 33)), through, title);
    return { type: '3d', size: baked.size, data: Array.from(baked.data), title, domainMin, domainMax };
  }
  const n = Math.min(MAX_1D, Math.max(lut.size, 1024));
  const data = new Array(n * 3);
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1), o = through(t, t, t);
    data[i * 3] = o[0];
    data[i * 3 + 1] = o[1];
    data[i * 3 + 2] = o[2];
  }
  return { type: '1d', size: n, data, title, domainMin, domainMax };
}

/** Format of a LUT file from its name, else from its content: 'cube' | '3dl' | 'look' | 'csp'. */
export function lutFormat(text, name = '') {
  const ext = (/\.([a-z0-9]+)$/i.exec(name)?.[1] ?? '').toLowerCase();
  if (['cube', '3dl', 'look', 'csp'].includes(ext)) return ext;
  const head = text.slice(0, 4096);
  if (/^\s*CSPLUTV100/i.test(head)) return 'csp';
  if (/<look|<\?xml/i.test(head)) return 'look';
  if (/LUT_(3D|1D)_SIZE/i.test(text)) return 'cube';
  return '3dl';
}

/**
 * Parses any supported LUT file (the name's extension picks the format, the content is the fallback).
 * The title defaults to the file name without its extension.
 * @param {string | Uint8Array} input @param {string} [name] @returns {Lut}
 */
export function parseLut(input, name = '') {
  const text = toText(input);
  const lut = { cube: parseCube, '3dl': parse3dl, look: parseLook, csp: parseCsp }[lutFormat(text, name)](text);
  if (!lut.title) lut.title = name.split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
  return lut;
}

// ---------------------------------------------------------------------------------------------
// Writers

const fmt6 = (v) => (Math.round(v * 1e6) / 1e6).toFixed(6);

/** .cube text of a table (1D or 3D), six decimals per value. */
export function writeCube(lut, { title = lut?.title ?? '' } = {}) {
  if (!isLut(lut)) fail('writeCube: not a lookup table');
  const out = [];
  if (title) out.push(`TITLE "${String(title).replace(/"/g, "'")}"`);
  out.push(`${lut.type === '3d' ? 'LUT_3D_SIZE' : 'LUT_1D_SIZE'} ${lut.size}`);
  const lo = lut.domainMin ?? [0, 0, 0], hi = lut.domainMax ?? [1, 1, 1];
  out.push(`DOMAIN_MIN ${lo.map(fmt6).join(' ')}`, `DOMAIN_MAX ${hi.map(fmt6).join(' ')}`);
  const d = lut.data;
  for (let i = 0; i < d.length; i += 3) out.push(`${fmt6(d[i])} ${fmt6(d[i + 1])} ${fmt6(d[i + 2])}`);
  return out.join('\n') + '\n';
}

/**
 * Autodesk .3dl text of a 3D table: a 10-bit input ramp, then rows with blue fastest scaled to
 * `bits` (12 by default). A table with a non-default input domain or a 1D table is resampled over 0..1 first.
 */
export function write3dl(lut, { bits = 12, title = lut?.title ?? '' } = {}) {
  if (!isLut(lut)) fail('write3dl: not a lookup table');
  const lo = lut.domainMin, hi = lut.domainMax;
  const unit = (!lo || lo.every((v) => v === 0)) && (!hi || hi.every((v) => v === 1));
  const src = lut.type === '3d' && unit ? lut : resampleLut(lut, lut.type === '3d' ? lut.size : 33);
  const n = src.size, d = src.data, scale = 2 ** bits - 1;
  const out = [];
  if (title) out.push(`# TITLE: ${String(title).replace(/[\r\n]+/g, ' ')}`);
  const ramp = [];
  for (let i = 0; i < n; i++) ramp.push(Math.round((i * 1023) / (n - 1)));
  out.push(ramp.join(' '));
  const q = (v) => Math.max(0, Math.min(scale, Math.round(v * scale)));
  for (let r = 0; r < n; r++) for (let g = 0; g < n; g++) for (let b = 0; b < n; b++) {
    const i = (r + g * n + b * n * n) * 3;
    out.push(`${q(d[i])} ${q(d[i + 1])} ${q(d[i + 2])}`);
  }
  return out.join('\n') + '\n';
}

// ---------------------------------------------------------------------------------------------
// Built-in presets: colour transforms written in code and sampled into 33³ tables on first use.
// They carry the names of Photoshop's Color Lookup presets and aim at the same character (a warm
// crisp grade, a cold bleak one, day for night ...) without reproducing Adobe's tables.

const c01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lumaOf = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
/** S-curve around mid grey: k > 1 adds contrast, k < 1 flattens (0 and 1 stay fixed). */
const sc = (x, k) => {
  x = c01(x);
  const a = x ** k, b = (1 - x) ** k;
  return a / (a + b);
};
const contrast = (c, k) => [sc(c[0], k), sc(c[1], k), sc(c[2], k)];
const saturate = (c, s) => {
  const l = lumaOf(c[0], c[1], c[2]);
  return [l + (c[0] - l) * s, l + (c[1] - l) * s, l + (c[2] - l) * s];
};
/** Per-channel gain around black (white balance like): [r, g, b] multipliers. */
const gain = (c, m) => [c[0] * m[0], c[1] * m[1], c[2] * m[2]];
const gamma = (c, g) => [c01(c[0]) ** g, c01(c[1]) ** g, c01(c[2]) ** g];
/** Lifts black to `lo` and lowers white to `hi` (a faded print). */
const fade = (c, lo, hi = 1) => [lo + c[0] * (hi - lo), lo + c[1] * (hi - lo), lo + c[2] * (hi - lo)];
/** Split toning: adds `sh` (an RGB offset) in the shadows and `hl` in the highlights, weighted by luma. */
const split = (c, sh, hl, amount = 1) => {
  const l = c01(lumaOf(c[0], c[1], c[2]));
  const ws = (1 - l) * (1 - l) * amount, wh = l * l * amount;
  return [c[0] + sh[0] * ws + hl[0] * wh, c[1] + sh[1] * ws + hl[1] * wh, c[2] + sh[2] * ws + hl[2] * wh];
};
const matrix = (c, m) => [c[0] * m[0] + c[1] * m[1] + c[2] * m[2], c[0] * m[3] + c[1] * m[4] + c[2] * m[5], c[0] * m[6] + c[1] * m[7] + c[2] * m[8]];
const mixTo = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
/** Luma mapped onto a tint ramp black -> colour -> white (monochrome toning). */
const tone = (c, color) => {
  const l = c01(lumaOf(c[0], c[1], c[2]));
  const cl = lumaOf(color[0], color[1], color[2]);
  return l < cl ? [(color[0] * l) / cl, (color[1] * l) / cl, (color[2] * l) / cl] : mixTo(color, [1, 1, 1], (l - cl) / (1 - cl));
};
/** Scales the saturation of one hue family (centre in degrees, width in degrees) by s. */
const hueSat = (c, centre, width, s) => {
  const max = Math.max(c[0], c[1], c[2]), min = Math.min(c[0], c[1], c[2]), d = max - min;
  if (d <= 1e-6) return c;
  let h = max === c[0] ? ((c[1] - c[2]) / d) % 6 : max === c[1] ? (c[2] - c[0]) / d + 2 : (c[0] - c[1]) / d + 4;
  h = (h * 60 + 360) % 360;
  let dist = Math.abs(h - centre);
  if (dist > 180) dist = 360 - dist;
  const w = dist >= width ? 0 : 0.5 + 0.5 * Math.cos((Math.PI * dist) / width);
  return w ? saturate(c, 1 + (s - 1) * w) : c;
};

/** name -> transform([r, g, b] 0..1) -> [r, g, b]; outputs are clamped when the table is built. */
const PRESET_FNS = {
  '2Strip': (c) => saturate(matrix(c, [1, 0, 0, 0, 0.55, 0.45, 0, 0.45, 0.55]), 1.15),
  '3Strip': (c) => contrast(saturate(matrix(c, [1.12, -0.06, -0.06, -0.06, 1.12, -0.06, -0.06, -0.06, 1.12]), 1.35), 1.2),
  'Bleach Bypass': (c) => contrast(saturate(c, 0.45), 1.55),
  Candlelight: (c) => gamma(split(gain(saturate(c, 0.9), [1.12, 0.96, 0.7]), [0.03, 0.01, -0.02], [0.05, 0.02, -0.08]), 0.95),
  'Crisp Warm': (c) => contrast(gain(saturate(c, 1.1), [1.07, 1.01, 0.9]), 1.25),
  'Crisp Winter': (c) => contrast(gain(saturate(c, 0.92), [0.93, 1, 1.1]), 1.25),
  'Drop Blues': (c) => hueSat(hueSat(c, 240, 70, 0.15), 200, 50, 0.5),
  'Edgy Amber': (c) => contrast(split(saturate(gain(c, [1.1, 0.98, 0.72]), 0.85), [0.02, 0, -0.03], [0.06, 0.03, -0.1]), 1.45),
  'Fall Colors': (c) => contrast(saturate(matrix(c, [1.1, 0.12, -0.1, 0.02, 0.92, 0.02, -0.04, 0.02, 0.8]), 1.2), 1.1),
  'Filmstock 50': (c) => fade(contrast(gain(saturate(c, 0.9), [1.02, 1, 0.95]), 1.2), 0.03, 0.97),
  'Foggy Night': (c) => fade(gain(saturate(gamma(c, 1.25), 0.55), [0.85, 0.97, 1.08]), 0.08, 0.8),
  'Fuji Eterna 250D': (c) => fade(split(contrast(saturate(c, 0.88), 1.15), [-0.01, 0.015, 0.02], [0.02, 0.01, -0.02]), 0.025, 0.98),
  'Fuji F125': (c) => split(contrast(saturate(c, 1.05), 1.3), [-0.015, 0.01, 0.03], [0.03, 0.015, -0.03]),
  'Futuristic Bleak': (c) => fade(contrast(gain(saturate(c, 0.35), [0.94, 1.02, 1.04]), 1.2), 0.04, 0.92),
  'Horror Blue': (c) => contrast(split(gain(saturate(c, 0.5), [0.72, 0.95, 1.2]), [0, 0.01, 0.05], [-0.03, 0, 0.04]), 1.3),
  'Kodak 5205': (c) => split(contrast(saturate(c, 1.08), 1.22), [-0.01, 0.005, 0.02], [0.035, 0.015, -0.04]),
  'Kodak 5218': (c) => split(contrast(saturate(c, 0.98), 1.35), [0, 0.01, 0.025], [0.04, 0.02, -0.05]),
  'Late Sunset': (c) => contrast(split(gain(c, [1.18, 0.92, 0.72]), [0.05, -0.01, 0.03], [0.08, 0.01, -0.1]), 1.15),
  Moonlight: (c) => gain(saturate(gamma(c, 1.5), 0.35), [0.7, 0.9, 1.15]),
  'Night from Day': (c) => fade(gain(saturate(gamma(c, 1.9), 0.4), [0.55, 0.78, 1.1]), 0, 0.7),
  'Soft Warming': (c) => fade(contrast(gain(c, [1.05, 1.01, 0.93]), 0.9), 0.02, 0.99),
  'Teal Orange': (c) => contrast(split(saturate(c, 1.1), [-0.06, 0.03, 0.06], [0.08, 0.02, -0.08], 1.2), 1.25),
  'Tension Green': (c) => contrast(split(gain(saturate(c, 0.8), [0.94, 1.06, 0.9]), [-0.02, 0.03, -0.01], [0, 0.03, -0.03]), 1.3),
  'Cross Process': (c) => [sc(c[0], 1.5), sc(c[1], 1.2), 0.12 + c01(c[2]) * 0.72],
  'Faded 47': (c) => fade(saturate(contrast(c, 0.92), 0.8), 0.09, 0.93),
  'Gold-Crimson': (c) => mixTo(c, tone(c, [0.75, 0.2, 0.1]), 0.55),
  'Cobalt-Carmine': (c) => split(saturate(c, 1.05), [0, 0.01, 0.12], [0.1, -0.02, 0], 1.3),
  'Turquoise-Sepia': (c) => split(saturate(c, 0.7), [-0.03, 0.07, 0.08], [0.09, 0.05, -0.06], 1.3),
  Sepia: (c) => tone(c, [0.62, 0.45, 0.28]),
  'Black & White': (c) => {
    const l = sc(lumaOf(c[0], c[1], c[2]), 1.1);
    return [l, l, l];
  },
  Infrared: (c) => {
    const l = c01(1.6 * c[1] + 0.5 * c[0] - 1.1 * c[2]);
    return contrast([l, l, l], 1.3);
  },
};

/** The built-in Color Lookup presets: display name -> colour transform ([r, g, b] 0..1 in and out). */
export const LUT_PRESETS = Object.freeze({ ...PRESET_FNS });
/** Preset names in menu order (alphabetical, like Photoshop's list). */
export const LUT_PRESET_NAMES = Object.freeze(Object.keys(PRESET_FNS).sort((a, b) => a.localeCompare(b, 'en', { numeric: true })));

const PRESET_TABLES = new Map();

/** The 3D table of a built-in preset (cached per name and size), or null for an unknown name. */
export function presetLut(name, size = 33) {
  if (!Object.prototype.hasOwnProperty.call(PRESET_FNS, name)) return null;
  const key = `${name}@${size}`;
  let lut = PRESET_TABLES.get(key);
  if (!lut) {
    const fn = PRESET_FNS[name];
    lut = makeLut3d(size, (r, g, b) => {
      const o = fn([r, g, b]);
      return [c01(o[0]), c01(o[1]), c01(o[2])];
    }, name);
    PRESET_TABLES.set(key, lut);
  }
  return lut;
}
