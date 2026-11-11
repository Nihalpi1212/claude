// Colour quantisation for Indexed Color, GIF and PNG-8 (see ARCHITECTURE.md "Image modes").
//
// quantize(img, options) reduces an RGBA image to a palette of at most 256 colours plus one index
// per pixel. Palettes are either built from the image (median cut: 'adaptive' in RGB, 'perceptual'
// and 'selective' in CIE Lab, all weighted by how many pixels use a colour), taken from the image
// as they are ('exact', when it has few enough colours) or fixed ('web', 'uniform', the two system
// palettes, 'custom'). Pixels map to the nearest palette entry (plain RGB distance, so a colour
// that is in the palette always maps to itself), optionally dithered: Floyd–Steinberg error
// diffusion, an 8×8 ordered pattern, or deterministic noise.
//
// Everything is pure: ImageDataLike in, typed arrays out, no DOM. Conventions as in filters.js:
// straight alpha, deterministic results, typed arrays and plain loops.
import { rgbToLab } from './color.js';

const clampByte = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);

/** 8×8 Bayer matrix (values 0..63), the threshold map of the ordered ("pattern") dither. */
export const BAYER8 = (() => {
  // M(2n) = [[4M, 4M + 2], [4M + 3, 4M + 1]] starting from M(1) = [0]
  let m = [[0]];
  for (let size = 1; size < 8; size *= 2) {
    const next = [];
    for (let y = 0; y < size * 2; y++) {
      next.push([]);
      for (let x = 0; x < size * 2; x++) {
        const v = 4 * m[y % size][x % size];
        next[y].push(v + (y < size ? (x < size ? 0 : 2) : x < size ? 3 : 1));
      }
    }
    m = next;
  }
  return Uint8Array.from(m.flat());
})();

// ---- fixed palettes ---------------------------------------------------------------------------------------------

/** The 216 "web-safe" colours: every combination of 00/33/66/99/CC/FF, white first. */
export function webPalette() {
  const out = [];
  for (let r = 5; r >= 0; r--) for (let g = 5; g >= 0; g--) for (let b = 5; b >= 0; b--) out.push([r * 51, g * 51, b * 51]);
  return out;
}

/**
 * The classic Mac OS 8-bit system palette: the web cube without black (215 entries, white first),
 * ten-step ramps of red, green, blue and grey that skip the cube's levels, and black last.
 */
export function macSystemPalette() {
  const out = webPalette().slice(0, 215);
  const ramp = [0xee, 0xdd, 0xbb, 0xaa, 0x88, 0x77, 0x55, 0x44, 0x22, 0x11];
  for (const v of ramp) out.push([v, 0, 0]);
  for (const v of ramp) out.push([0, v, 0]);
  for (const v of ramp) out.push([0, 0, v]);
  for (const v of ramp) out.push([v, v, v]);
  out.push([0, 0, 0]);
  return out;
}

/**
 * An approximation of the Windows 8-bit system palette: the 20 static system colours, the web cube
 * and a grey ramp filling the rest (the real default palette is defined by the display driver, so
 * no table is exact; these are the colours every Windows palette manager reserves or dithers with).
 */
export function windowsSystemPalette() {
  const statics = [
    [0, 0, 0], [128, 0, 0], [0, 128, 0], [128, 128, 0], [0, 0, 128], [128, 0, 128], [0, 128, 128], [192, 192, 192], [192, 220, 192], [166, 202, 240],
    [255, 251, 240], [160, 160, 164], [128, 128, 128], [255, 0, 0], [0, 255, 0], [255, 255, 0], [0, 0, 255], [255, 0, 255], [0, 255, 255], [255, 255, 255],
  ];
  const out = [];
  const seen = new Set();
  const add = (c) => {
    const k = (c[0] << 16) | (c[1] << 8) | c[2];
    if (seen.has(k) || out.length >= 256) return;
    seen.add(k);
    out.push(c);
  };
  statics.forEach(add);
  webPalette().forEach(add);
  for (let i = 1; out.length < 256 && i < 64; i++) add([i * 4, i * 4, i * 4]);
  return out;
}

/** A uniform RGB cube with as many levels per channel as fit in `colors` (2 → black/white only when colors < 8). */
export function uniformPalette(colors = 256) {
  const n = Math.max(2, Math.min(256, Math.floor(colors)));
  if (n < 8) {
    // fewer than 2×2×2: a grey ramp is the only uniform choice
    return Array.from({ length: n }, (_, i) => {
      const v = Math.round((i * 255) / (n - 1));
      return [v, v, v];
    });
  }
  let levels = Math.floor(Math.cbrt(n) + 1e-9);
  levels = Math.max(2, Math.min(6, levels));
  const out = [];
  for (let r = 0; r < levels; r++) for (let g = 0; g < levels; g++) for (let b = 0; b < levels; b++) out.push([Math.round((r * 255) / (levels - 1)), Math.round((g * 255) / (levels - 1)), Math.round((b * 255) / (levels - 1))]);
  return out;
}

const FORCED = {
  none: [],
  'black-white': [[0, 0, 0], [255, 255, 255]],
  primaries: [[0, 0, 0], [255, 255, 255], [255, 0, 0], [0, 255, 0], [0, 0, 255], [0, 255, 255], [255, 0, 255], [255, 255, 0]],
};
const forcedColors = (kind) => (kind === 'web' ? webPalette() : FORCED[kind] ?? []);

/** '#rrggbb' | [r, g, b] | null → [r, g, b] | null (no dependency on color.js parsing so arrays pass straight through). */
function toRgb(c) {
  if (!c) return null;
  if (Array.isArray(c) || ArrayBuffer.isView(c)) return [clampByte(Math.round(c[0])), clampByte(Math.round(c[1])), clampByte(Math.round(c[2]))];
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})/i.exec(String(c).trim());
  if (!m) return null;
  const h = m[1].length === 3 ? m[1].split('').map((x) => x + x).join('') : m[1];
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

// ---- nearest palette entry --------------------------------------------------------------------------------------

/**
 * Exact nearest-colour lookup for a palette, fast enough to run per pixel: RGB space is cut into
 * 16³ cells and every cell lists the entries that can be nearest to some point in it (an entry is
 * dropped when its closest point of the cell is farther than another entry's farthest point).
 * Ties go to the lowest index.
 * @param {number[][]} palette [[r, g, b], ...] (1..256 entries)
 * @param {number} [skipIndex] an index that is never returned (the transparent entry)
 */
export function createMapper(palette, skipIndex = -1) {
  const n = palette.length;
  const pr = new Int32Array(n), pg = new Int32Array(n), pb = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    pr[i] = palette[i][0];
    pg[i] = palette[i][1];
    pb[i] = palette[i][2];
  }
  const usable = [];
  for (let i = 0; i < n; i++) if (i !== skipIndex) usable.push(i);
  if (!usable.length) usable.push(0);
  const exact = new Map();
  for (let k = usable.length - 1; k >= 0; k--) exact.set((pr[usable[k]] << 16) | (pg[usable[k]] << 8) | pb[usable[k]], usable[k]);

  let offsets = null, cells = null;
  function build() {
    const list = [];
    offsets = new Int32Array(4097);
    const dmin = new Float64Array(usable.length), dmax = new Float64Array(usable.length);
    for (let cr = 0; cr < 16; cr++) for (let cg = 0; cg < 16; cg++) for (let cb = 0; cb < 16; cb++) {
      const r0 = cr * 16, g0 = cg * 16, b0 = cb * 16, r1 = r0 + 15, g1 = g0 + 15, b1 = b0 + 15;
      let best = Infinity;
      for (let k = 0; k < usable.length; k++) {
        const i = usable[k];
        const r = pr[i], g = pg[i], b = pb[i];
        const nr = r < r0 ? r0 - r : r > r1 ? r - r1 : 0, ng = g < g0 ? g0 - g : g > g1 ? g - g1 : 0, nb = b < b0 ? b0 - b : b > b1 ? b - b1 : 0;
        const fr = Math.max(Math.abs(r - r0), Math.abs(r - r1)), fg = Math.max(Math.abs(g - g0), Math.abs(g - g1)), fb = Math.max(Math.abs(b - b0), Math.abs(b - b1));
        dmin[k] = nr * nr + ng * ng + nb * nb;
        dmax[k] = fr * fr + fg * fg + fb * fb;
        if (dmax[k] < best) best = dmax[k];
      }
      offsets[(cr << 8) | (cg << 4) | cb] = list.length;
      for (let k = 0; k < usable.length; k++) if (dmin[k] <= best) list.push(usable[k]);
    }
    offsets[4096] = list.length;
    cells = Uint8Array.from(list);
  }

  // answers are remembered in a direct-mapped cache: images repeat colours far more often than they invent them
  let cacheKeys = null, cacheVals = null;

  /** Index of the palette entry nearest to (r, g, b), channels 0..255 (clamped). */
  function nearest(r, g, b) {
    r = r < 0 ? 0 : r > 255 ? 255 : r | 0;
    g = g < 0 ? 0 : g > 255 ? 255 : g | 0;
    b = b < 0 ? 0 : b > 255 ? 255 : b | 0;
    if (usable.length <= 8) return search(r, g, b);
    if (!cacheKeys) {
      cacheKeys = new Int32Array(1 << 16).fill(-1);
      cacheVals = new Uint8Array(1 << 16);
    }
    const key = (r << 16) | (g << 8) | b;
    const slot = (Math.imul(key, 0x9e3779b1) >>> 16) & 0xffff;
    if (cacheKeys[slot] === key) return cacheVals[slot];
    const found = search(r, g, b);
    cacheKeys[slot] = key;
    cacheVals[slot] = found;
    return found;
  }

  function search(r, g, b) {
    let best = 0, bestD = Infinity;
    if (usable.length <= 8) {
      for (let k = 0; k < usable.length; k++) {
        const i = usable[k];
        const dr = r - pr[i], dg = g - pg[i], db = b - pb[i];
        const d = dr * dr + dg * dg + db * db;
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      return best;
    }
    if (!cells) build();
    const c = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    for (let k = offsets[c], end = offsets[c + 1]; k < end; k++) {
      const i = cells[k];
      const dr = r - pr[i], dg = g - pg[i], db = b - pb[i];
      const d = dr * dr + dg * dg + db * db;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }
  return { nearest, exact, size: n };
}

// ---- preparing pixels --------------------------------------------------------------------------------------------

/**
 * What the palette is built from and mapped onto: every pixel either opaque (alpha 255) or fully
 * transparent (alpha 0). With `transparency`, pixels under 50% alpha become transparent and the
 * rest are blended with the matte when there is one; without it everything is blended with the
 * matte (white when none is given), as Photoshop's Indexed Color and Save for Web do.
 */
export function prepareForIndex(img, { transparency = true, matte = null } = {}) {
  const src = img.data;
  const out = new Uint8ClampedArray(src.length);
  const m = toRgb(matte) ?? (transparency ? null : [255, 255, 255]);
  let transparent = false;
  for (let i = 0; i < src.length; i += 4) {
    const a = src[i + 3];
    if (a === 255) {
      out[i] = src[i];
      out[i + 1] = src[i + 1];
      out[i + 2] = src[i + 2];
      out[i + 3] = 255;
    } else if (transparency && a < 128) {
      transparent = true; // out stays 0,0,0,0
    } else if (m) {
      const k = a / 255;
      out[i] = src[i] * k + m[0] * (1 - k);
      out[i + 1] = src[i + 1] * k + m[1] * (1 - k);
      out[i + 2] = src[i + 2] * k + m[2] * (1 - k);
      out[i + 3] = 255;
    } else {
      out[i] = src[i];
      out[i + 1] = src[i + 1];
      out[i + 2] = src[i + 2];
      out[i + 3] = 255;
    }
  }
  return { width: img.width, height: img.height, data: out, hasTransparency: transparent };
}

/**
 * Distinct opaque colours with their pixel counts. Up to `limit` colours are kept exactly; an image
 * with more is binned to 6 bits per channel (each bin's colour is the mean of its pixels).
 * @returns {{ r: Float32Array, g: Float32Array, b: Float32Array, count: Float64Array, n: number, exact: boolean }}
 */
export function colorHistogram(img, limit = 1 << 16) {
  const d = img.data;
  let bits = 12;
  let keys = new Int32Array(1 << bits).fill(-1);
  let counts = new Uint32Array(1 << bits);
  let n = 0;
  let overflow = false;
  const insert = (key, c) => {
    const mask = (1 << bits) - 1;
    let h = (Math.imul(key, 0x9e3779b1) >>> (32 - bits)) & mask;
    while (keys[h] !== -1 && keys[h] !== key) h = (h + 1) & mask;
    if (keys[h] === -1) {
      keys[h] = key;
      n++;
    }
    counts[h] += c;
  };
  let prevKey = -1, run = 0;
  for (let i = 0; i < d.length && !overflow; i += 4) {
    if (d[i + 3] < 128) continue;
    const key = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2];
    // runs of one colour (flat artwork) are counted in one insert
    if (key === prevKey) {
      run++;
      continue;
    }
    if (run) insert(prevKey, run);
    prevKey = key;
    run = 1;
    if (n > limit) overflow = true;
    else if (n * 2 > 1 << bits) {
      const oldKeys = keys, oldCounts = counts;
      bits += 2;
      keys = new Int32Array(1 << bits).fill(-1);
      counts = new Uint32Array(1 << bits);
      n = 0;
      for (let k = 0; k < oldKeys.length; k++) if (oldKeys[k] !== -1) insert(oldKeys[k], oldCounts[k]);
    }
  }
  if (!overflow) {
    if (run) insert(prevKey, run);
    if (n <= limit) {
      const r = new Float32Array(n), g = new Float32Array(n), b = new Float32Array(n), count = new Float64Array(n);
      // sorted by colour value so the result never depends on hash order
      const order = [];
      for (let k = 0; k < keys.length; k++) if (keys[k] !== -1) order.push(k);
      order.sort((x, y) => keys[x] - keys[y]);
      for (let j = 0; j < n; j++) {
        const key = keys[order[j]];
        r[j] = key >> 16;
        g[j] = (key >> 8) & 255;
        b[j] = key & 255;
        count[j] = counts[order[j]];
      }
      return { r, g, b, count, n, exact: true };
    }
  }
  // too many colours: 64×64×64 bins holding sums, so a bin's colour is the mean of what fell into it
  const size = 1 << 18;
  const bc = new Uint32Array(size), sr = new Float64Array(size), sg = new Float64Array(size), sb = new Float64Array(size);
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 128) continue;
    const k = ((d[i] >> 2) << 12) | ((d[i + 1] >> 2) << 6) | (d[i + 2] >> 2);
    bc[k]++;
    sr[k] += d[i];
    sg[k] += d[i + 1];
    sb[k] += d[i + 2];
  }
  let m = 0;
  for (let k = 0; k < size; k++) if (bc[k]) m++;
  const r = new Float32Array(m), g = new Float32Array(m), b = new Float32Array(m), count = new Float64Array(m);
  for (let k = 0, j = 0; k < size; k++) if (bc[k]) {
    r[j] = sr[k] / bc[k];
    g[j] = sg[k] / bc[k];
    b[j] = sb[k] / bc[k];
    count[j++] = bc[k];
  }
  return { r, g, b, count, n: m, exact: false };
}

/** Number of distinct opaque colours, or `limit + 1` when there are more than `limit`. */
export function countColors(img, limit = 256) {
  const seen = new Set();
  const d = img.data;
  let prev = -1;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 128) continue;
    const key = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2];
    if (key === prev) continue;
    prev = key;
    seen.add(key);
    if (seen.size > limit) return limit + 1;
  }
  return seen.size;
}

// ---- median cut --------------------------------------------------------------------------------------------------

/**
 * Median cut over a colour histogram: the box with the largest spread (weighted squared error along
 * its widest axis) is split at the weighted median of that axis until `colors` boxes exist; each
 * box becomes the weighted mean of its colours. A histogram with no more colours than requested
 * comes back unchanged, so flat artwork keeps its exact colours.
 * @param {{ r, g, b, count, n }} hist
 * @param {number} colors
 * @param {'rgb'|'lab'} space the space boxes are measured and cut in
 * @returns {number[][]} [[r, g, b], ...] rounded to bytes, most used colour first
 */
export function medianCut(hist, colors, space = 'rgb') {
  const n = hist.n;
  if (!n || colors <= 0) return [];
  const usage = (list) => list.sort((a, b) => b[3] - a[3] || ((a[0] << 16) | (a[1] << 8) | a[2]) - ((b[0] << 16) | (b[1] << 8) | b[2])).map((c) => [c[0], c[1], c[2]]);
  if (n <= colors) {
    const list = [];
    for (let i = 0; i < n; i++) list.push([Math.round(hist.r[i]), Math.round(hist.g[i]), Math.round(hist.b[i]), hist.count[i]]);
    return dedupe(usage(list));
  }
  // coordinates the boxes are cut in
  let c0 = hist.r, c1 = hist.g, c2 = hist.b;
  if (space === 'lab') {
    c0 = new Float32Array(n);
    c1 = new Float32Array(n);
    c2 = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const lab = rgbToLab(hist.r[i], hist.g[i], hist.b[i]);
      c0[i] = lab[0];
      c1[i] = lab[1];
      c2[i] = lab[2];
    }
  }
  const axes = [c0, c1, c2];
  const w = hist.count;
  const order = new Int32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;

  const measure = (start, end) => {
    // weighted variance per axis; the box's priority is its largest sum of squared errors
    let sw = 0;
    const s = [0, 0, 0], q = [0, 0, 0];
    for (let k = start; k < end; k++) {
      const i = order[k], wi = w[i];
      sw += wi;
      for (let a = 0; a < 3; a++) {
        const v = axes[a][i];
        s[a] += v * wi;
        q[a] += v * v * wi;
      }
    }
    let axis = 0, score = -1;
    for (let a = 0; a < 3; a++) {
      const sse = q[a] - (s[a] * s[a]) / sw;
      if (sse > score) {
        score = sse;
        axis = a;
      }
    }
    return { start, end, axis, score: end - start > 1 ? score : -1, weight: sw };
  };

  const boxes = [measure(0, n)];
  while (boxes.length < colors) {
    let pick = -1, best = 0;
    for (let k = 0; k < boxes.length; k++) if (boxes[k].score > best) {
      best = boxes[k].score;
      pick = k;
    }
    if (pick < 0) break; // every box holds a single colour (or identical ones)
    const box = boxes[pick];
    const coord = axes[box.axis];
    const part = order.subarray(box.start, box.end);
    part.sort((x, y) => coord[x] - coord[y] || x - y);
    // weighted median: the first cut where the left half holds at least half the pixels, both sides non-empty
    // and the cut falls between two different coordinates when possible
    let acc = 0, cut = box.start + 1;
    for (let k = box.start; k < box.end - 1; k++) {
      acc += w[order[k]];
      cut = k + 1;
      if (acc * 2 >= box.weight) break;
    }
    if (coord[order[cut - 1]] === coord[order[cut]]) {
      let lo = cut, hi = cut;
      while (lo > box.start + 1 && coord[order[lo - 1]] === coord[order[lo]]) lo--;
      while (hi < box.end - 1 && coord[order[hi - 1]] === coord[order[hi]]) hi++;
      const loOk = coord[order[lo - 1]] !== coord[order[lo]], hiOk = coord[order[hi - 1]] !== coord[order[hi]];
      if (loOk && hiOk) cut = cut - lo <= hi - cut ? lo : hi;
      else if (loOk) cut = lo;
      else if (hiOk) cut = hi;
    }
    boxes.splice(pick, 1, measure(box.start, cut), measure(cut, box.end));
  }
  const list = boxes.map((box) => {
    let sw = 0, r = 0, g = 0, b = 0;
    for (let k = box.start; k < box.end; k++) {
      const i = order[k], wi = w[i];
      sw += wi;
      r += hist.r[i] * wi;
      g += hist.g[i] * wi;
      b += hist.b[i] * wi;
    }
    return [Math.round(r / sw), Math.round(g / sw), Math.round(b / sw), sw];
  });
  return dedupe(usage(list));
}

function dedupe(list) {
  const seen = new Set();
  const out = [];
  for (const c of list) {
    const k = (c[0] << 16) | (c[1] << 8) | c[2];
    if (seen.has(k)) continue;
    seen.add(k);
    out.push([c[0], c[1], c[2]]);
  }
  return out;
}

// ---- palettes -----------------------------------------------------------------------------------------------------

export const PALETTE_KINDS = ['exact', 'system-mac', 'system-win', 'web', 'uniform', 'perceptual', 'selective', 'adaptive', 'custom'];
export const FORCED_KINDS = ['none', 'black-white', 'primaries', 'web'];
export const DITHER_KINDS = ['none', 'diffusion', 'pattern', 'noise'];

/**
 * Builds the palette for an image that prepareForIndex() made binary-alpha.
 * @returns {number[][]} at most `colors` entries (one fewer when a transparent entry will be added)
 */
export function buildPalette(prepared, { colors = 256, palette = 'adaptive', forced = 'none', custom = null, reserve = 0 } = {}) {
  const max = Math.max(1, Math.min(256, Math.floor(colors)) - reserve);
  let base;
  switch (palette) {
    case 'web': base = webPalette(); break;
    case 'system-mac': base = macSystemPalette(); break;
    case 'system-win': base = windowsSystemPalette(); break;
    case 'uniform': base = uniformPalette(max); break;
    case 'custom': base = (custom ?? []).map(toRgb).filter(Boolean); break;
    default: base = null;
  }
  if (base) {
    if (!base.length) base = [[0, 0, 0], [255, 255, 255]];
    return trimToUsage(prepared, dedupe(base), Math.min(256 - reserve, palette === 'uniform' ? max : 256));
  }
  const force = dedupe(forcedColors(forced)).slice(0, max);
  const hist = colorHistogram(prepared);
  const room = max - force.length;
  let picked = [];
  if (room > 0) {
    // 'exact' only differs from the others when the image has few enough colours; beyond that it falls back to adaptive
    picked = medianCut(hist, room, palette === 'perceptual' || palette === 'selective' ? 'lab' : 'rgb');
    if (palette === 'selective') picked = picked.map(snapToWeb);
  }
  const out = dedupe([...force, ...picked]).slice(0, max);
  return out.length ? out : [[0, 0, 0]];
}

/** Selective palettes keep web colours: an entry within 6 levels of a web-safe colour becomes that colour. */
function snapToWeb(c) {
  const s = c.map((v) => Math.round(v / 51) * 51);
  return Math.abs(s[0] - c[0]) <= 6 && Math.abs(s[1] - c[1]) <= 6 && Math.abs(s[2] - c[2]) <= 6 ? s : c;
}

/** A fixed palette longer than `max` loses the entries the image uses least (ties: the later entry goes first). */
function trimToUsage(prepared, palette, max) {
  if (palette.length <= max) return palette;
  const hist = colorHistogram(prepared);
  const mapper = createMapper(palette);
  const use = new Float64Array(palette.length);
  for (let i = 0; i < hist.n; i++) use[mapper.nearest(Math.round(hist.r[i]), Math.round(hist.g[i]), Math.round(hist.b[i]))] += hist.count[i];
  const order = palette.map((_, i) => i).sort((a, b) => use[b] - use[a] || a - b).slice(0, max).sort((a, b) => a - b);
  return order.map((i) => palette[i]);
}

// ---- mapping ------------------------------------------------------------------------------------------------------

/**
 * Maps every pixel to a palette index.
 * @param {{ width, height, data }} img RGBA; alpha under 128 maps to `transparentIndex` when one is given
 * @param {number[][]} palette
 * @param {{ dither?: 'none'|'diffusion'|'pattern'|'noise', ditherAmount?: number, transparentIndex?: number, preserveExactColors?: boolean, seed?: number }} [opts]
 * @returns {Uint8Array} width*height indices
 */
export function remap(img, palette, { dither = 'none', ditherAmount = 100, transparentIndex = -1, preserveExactColors = false, seed = 1 } = {}) {
  const { width: w, height: h, data: d } = img;
  const out = new Uint8Array(w * h);
  const ti = transparentIndex >= 0 && transparentIndex < 256 ? transparentIndex : -1;
  const mapper = createMapper(palette, ti);
  const amount = Math.max(0, Math.min(100, Number(ditherAmount ?? 100))) / 100;
  const mode = amount > 0 ? dither : 'none';

  if (mode === 'diffusion') {
    // Floyd–Steinberg: 7/16 right, 3/16 below-left, 5/16 below, 1/16 below-right
    let cur = new Float32Array((w + 2) * 3), next = new Float32Array((w + 2) * 3);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = y * w + x, i = p * 4, e = (x + 1) * 3;
        if (ti >= 0 && d[i + 3] < 128) {
          out[p] = ti;
          continue;
        }
        const r0 = d[i], g0 = d[i + 1], b0 = d[i + 2];
        if (preserveExactColors) {
          const hit = mapper.exact.get((r0 << 16) | (g0 << 8) | b0);
          if (hit !== undefined) {
            out[p] = hit; // a colour of the palette stays itself and passes the accumulated error on unchanged
            const er = cur[e], eg = cur[e + 1], eb = cur[e + 2];
            spread(cur, next, e, er, eg, eb);
            continue;
          }
        }
        const r = clampByte(r0 + cur[e]), g = clampByte(g0 + cur[e + 1]), b = clampByte(b0 + cur[e + 2]);
        const k = mapper.nearest(Math.round(r), Math.round(g), Math.round(b));
        out[p] = k;
        const c = palette[k];
        spread(cur, next, e, (r - c[0]) * amount, (g - c[1]) * amount, (b - c[2]) * amount);
      }
      const t = cur;
      cur = next;
      next = t;
      next.fill(0);
    }
    return out;
  }

  // ordered and noise dithers offset each pixel before the lookup; the step is one palette "level"
  const spreadStep = 255 / Math.max(1, Math.cbrt(Math.max(2, palette.length - (ti >= 0 ? 1 : 0))) - 1);
  let prevKey = -1, prevIndex = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = y * w + x, i = p * 4;
    if (ti >= 0 && d[i + 3] < 128) {
      out[p] = ti;
      continue;
    }
    let r = d[i], g = d[i + 1], b = d[i + 2];
    if (mode === 'pattern' || mode === 'noise') {
      if (preserveExactColors && mapper.exact.has((r << 16) | (g << 8) | b)) {
        out[p] = mapper.exact.get((r << 16) | (g << 8) | b);
        continue;
      }
      const t = mode === 'pattern' ? (BAYER8[(y & 7) * 8 + (x & 7)] + 0.5) / 64 - 0.5 : hashNoise(x, y, seed) - 0.5;
      const o = t * spreadStep * amount;
      out[p] = mapper.nearest(Math.round(r + o), Math.round(g + o), Math.round(b + o));
      continue;
    }
    const key = (r << 16) | (g << 8) | b;
    if (key !== prevKey) {
      prevKey = key;
      prevIndex = mapper.nearest(r, g, b);
    }
    out[p] = prevIndex;
  }
  return out;
}

function spread(cur, next, e, er, eg, eb) {
  cur[e + 3] += er * 0.4375;
  cur[e + 4] += eg * 0.4375;
  cur[e + 5] += eb * 0.4375;
  next[e - 3] += er * 0.1875;
  next[e - 2] += eg * 0.1875;
  next[e - 1] += eb * 0.1875;
  next[e] += er * 0.3125;
  next[e + 1] += eg * 0.3125;
  next[e + 2] += eb * 0.3125;
  next[e + 3] += er * 0.0625;
  next[e + 4] += eg * 0.0625;
  next[e + 5] += eb * 0.0625;
}

/** Deterministic noise in [0, 1) per pixel. */
export function hashNoise(x, y, seed = 1) {
  let h = Math.imul(x + 0x9e3779b9, 0x85ebca6b) ^ Math.imul(y + 0x7f4a7c15, 0xc2b2ae35) ^ Math.imul(seed | 0, 0x27d4eb2f);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

/**
 * Quantises an RGBA image.
 * @param {{ width, height, data }} img
 * @param {{ colors?: number, palette?: string, forced?: string, transparency?: boolean, matte?: string|number[]|null, dither?: string, ditherAmount?: number, preserveExactColors?: boolean, custom?: number[][] }} [options]
 * @returns {{ palette: number[][], indices: Uint8Array, transparentIndex: number }} transparentIndex is -1 when no pixel is transparent
 */
export function quantize(img, options = {}) {
  const { colors = 256, palette = 'adaptive', forced = 'none', transparency = true, matte = null, dither = 'none', ditherAmount = 75, preserveExactColors = false, custom = null } = options;
  const prepared = prepareForIndex(img, { transparency, matte });
  const needsTransparent = prepared.hasTransparency;
  const table = buildPalette(prepared, { colors: Math.max(2, Math.min(256, Math.round(Number(colors) || 256))), palette, forced, custom, reserve: needsTransparent ? 1 : 0 });
  let transparentIndex = -1;
  if (needsTransparent) {
    transparentIndex = table.length;
    table.push([0, 0, 0]); // the colour is never shown; black keeps files compatible with decoders that ignore tRNS
  }
  const indices = remap(prepared, table, { dither, ditherAmount, transparentIndex, preserveExactColors });
  return { palette: table, indices, transparentIndex };
}

/** RGBA image of an indexed result (transparent index → alpha 0). */
export function indicesToImage(indices, palette, width, height, transparentIndex = -1) {
  const data = new Uint8ClampedArray(width * height * 4);
  const n = palette.length;
  const lut = new Uint8Array(256 * 3);
  for (let i = 0; i < n && i < 256; i++) {
    lut[i * 3] = palette[i][0];
    lut[i * 3 + 1] = palette[i][1];
    lut[i * 3 + 2] = palette[i][2];
  }
  for (let p = 0, i = 0; p < indices.length && i < data.length; p++, i += 4) {
    const k = indices[p];
    if (k === transparentIndex) continue;
    data[i] = lut[k * 3];
    data[i + 1] = lut[k * 3 + 1];
    data[i + 2] = lut[k * 3 + 2];
    data[i + 3] = 255;
  }
  return { width, height, data };
}

// ---- Adobe Color Table (.act) ---------------------------------------------------------------------------------

/**
 * Reads an .act file: 256 RGB triples, optionally followed by a big-endian colour count and
 * transparent index (0xFFFF = none). Files without the trailer hold 256 colours.
 * @returns {{ palette: number[][], transparentIndex: number }}
 */
export function parseAct(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length < 3 || (b.length !== 768 && b.length !== 772 && b.length % 3 !== 0)) throw new Error('This is not a color table (.act) file');
  let count = Math.min(256, Math.floor(Math.min(b.length, 768) / 3));
  let transparentIndex = -1;
  if (b.length >= 772) {
    const n = (b[768] << 8) | b[769];
    const t = (b[770] << 8) | b[771];
    if (n > 0 && n <= 256) count = n;
    if (t < count) transparentIndex = t;
  }
  const palette = [];
  for (let i = 0; i < count; i++) palette.push([b[i * 3], b[i * 3 + 1], b[i * 3 + 2]]);
  return { palette, transparentIndex };
}

/** Writes an .act file (772 bytes: the table padded with black, the colour count and the transparent index). */
export function writeAct(palette, transparentIndex = -1) {
  const out = new Uint8Array(772);
  const n = Math.min(256, palette.length);
  for (let i = 0; i < n; i++) {
    out[i * 3] = palette[i][0];
    out[i * 3 + 1] = palette[i][1];
    out[i * 3 + 2] = palette[i][2];
  }
  out[768] = n >> 8;
  out[769] = n & 255;
  const t = transparentIndex >= 0 && transparentIndex < n ? transparentIndex : 0xffff;
  out[770] = t >> 8;
  out[771] = t & 255;
  return out;
}
