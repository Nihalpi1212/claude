// Selection operations on coverage masks. A mask is a Uint8ClampedArray(width * height) holding
// 0..255 coverage per pixel (0 = not selected, 255 = fully selected, in between = soft edge).
// Everything here is pure (no DOM, no canvas): it runs in the renderer, in the pixel worker and in
// Node tests. Functions that take an image read ImageDataLike ({ width, height, data }) with
// straight alpha. Every function accepts an optional rect (default: the whole image); pixels
// outside the rect are left as they were (or unselected for functions that build a new mask), and
// nothing is ever read or written outside the image. Mask inputs are never modified and every
// function returns a new mask, with one exception: feather() works IN PLACE and returns the same
// array (callers may use either the argument or the return value).
//
// What lies beyond the canvas:
//   feather                -> unselected (0): a selection touching the canvas edge fades there
//   expand/contract/border -> edge pixels are replicated (Photoshop's "do not apply at canvas bounds")
//   smooth                 -> ignored (the box mean is taken over the in-canvas part of the window)
//   outline                -> the canvas (or rect) edge is a boundary, so loops close along it

import { clampRect, makeLut } from './core.js';
import { parseColor } from './color.js';

/** @typedef {import('./core.js').ImageDataLike} ImageDataLike */
/** @typedef {import('./core.js').Rect} Rect */
/** @typedef {Uint8ClampedArray} Mask coverage per pixel, 0..255 */

const clampNum = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const noProbe = () => 1;

// ---------------------------------------------------------------------------------------------
// Colour matching (magic wand, colour range, grow, similar)
// ---------------------------------------------------------------------------------------------

/** Max channel difference between the pixel at byte offset p and (r, g, b, a), alpha as a channel. */
function maxDiff4(d, p, r, g, b, a) {
  let m = d[p] - r;
  if (m < 0) m = -m;
  let t = d[p + 1] - g;
  if (t < 0) t = -t;
  if (t > m) m = t;
  t = d[p + 2] - b;
  if (t < 0) t = -t;
  if (t > m) m = t;
  t = d[p + 3] - a;
  if (t < 0) t = -t;
  if (t > m) m = t;
  return m;
}

/** Coverage for a pixel at colour distance `dist`: 0 = no match, otherwise 2..255 (antialiased edge). */
function matchCoverage(dist, tol, lo, scale) {
  if (dist > tol) return 0;
  if (dist <= lo) return 255;
  const v = Math.round((tol + 1 - dist) * scale);
  return v < 2 ? 2 : v;
}

/**
 * Scanline/stack fill confined to rect r, starting at (sx, sy). `match` holds, per pixel, 0 = not yet
 * known (probe(i) computes and stores it), 1 = no match, >= 2 = match with that coverage. Coverage is
 * written into `out`, whose non-zero entries double as the visited set.
 */
function scanlineFill(match, probe, w, r, sx, sy, out) {
  const x0 = r.x, x1 = r.x + r.width, y0 = r.y, y1 = r.y + r.height;
  const stack = [sx, sy];
  while (stack.length) {
    const y = stack.pop(), x = stack.pop();
    const row = y * w;
    const i = row + x;
    if (out[i] !== 0) continue;
    if ((match[i] || probe(i)) < 2) continue;
    let xl = x, xr = x;
    while (xl > x0) {
      const j = row + xl - 1;
      if (out[j] !== 0 || (match[j] || probe(j)) < 2) break;
      xl--;
    }
    while (xr < x1 - 1) {
      const j = row + xr + 1;
      if (out[j] !== 0 || (match[j] || probe(j)) < 2) break;
      xr++;
    }
    for (let j = row + xl, e = row + xr; j <= e; j++) out[j] = match[j];
    for (let k = -1; k <= 1; k += 2) {
      const yy = y + k;
      if (yy < y0 || yy >= y1) continue;
      const r2 = yy * w;
      let inRun = false;
      for (let xx = xl; xx <= xr; xx++) {
        const j = r2 + xx;
        if (out[j] === 0 && (match[j] || probe(j)) >= 2) {
          if (!inRun) {
            stack.push(xx, yy);
            inRun = true;
          }
        } else inRun = false;
      }
    }
  }
}

/**
 * Magic wand: selects the pixels whose colour is within `tolerance` (max channel difference, alpha
 * counted as a channel) of the pixel at (x, y). `contiguous` limits the result to the 4-connected
 * region around the seed (scanline fill); otherwise every matching pixel in the rect is selected.
 * With `antialias`, pixels whose distance lies in the last 25% of the tolerance get a soft coverage
 * (never below 2) instead of 255. `sampleMerged` is a caller concern (pass the merged image).
 * @param {ImageDataLike} img
 * @param {number} x @param {number} y seed pixel
 * @param {{ tolerance?: number, contiguous?: boolean, antialias?: boolean }} [options]
 * @param {Rect|null} [rect] limits the fill; a seed outside it gives an empty mask
 * @returns {Mask}
 */
export function floodFill(img, x, y, { tolerance = 32, contiguous = true, antialias = false } = {}, rect = null) {
  const w = img.width, h = img.height, d = img.data;
  const mask = new Uint8ClampedArray(w * h);
  const r = clampRect(rect, w, h);
  const sx = Math.floor(x), sy = Math.floor(y);
  if (r.width <= 0 || sx < r.x || sy < r.y || sx >= r.x + r.width || sy >= r.y + r.height) return mask;
  const tol = clampNum(Math.round(tolerance) || 0, 0, 255);
  const lo = antialias ? tol * 0.75 : tol;
  const scale = 255 / (tol + 1 - lo);
  const p0 = (sy * w + sx) * 4;
  const tr = d[p0], tg = d[p0 + 1], tb = d[p0 + 2], ta = d[p0 + 3];
  if (!contiguous) {
    for (let yy = r.y, ye = r.y + r.height; yy < ye; yy++) {
      let i = yy * w + r.x, p = i * 4;
      for (let xx = 0; xx < r.width; xx++, i++, p += 4) {
        const dist = maxDiff4(d, p, tr, tg, tb, ta);
        if (dist <= tol) mask[i] = matchCoverage(dist, tol, lo, scale);
      }
    }
    return mask;
  }
  const match = new Uint8Array(w * h);
  const probe = (i) => {
    const v = matchCoverage(maxDiff4(d, i * 4, tr, tg, tb, ta), tol, lo, scale) || 1;
    match[i] = v;
    return v;
  };
  scanlineFill(match, probe, w, r, sx, sy, mask);
  return mask;
}

/**
 * Colour Range: coverage from the distance (max RGB channel difference) to the nearest of `colors`,
 * with Photoshop-like falloff: 255 while the distance is below fuzziness/2, fading linearly to 0 at
 * `fuzziness`. Coverage is scaled by the pixel's alpha, so transparent pixels are never selected.
 * @param {ImageDataLike} img
 * @param {Array<[number, number, number, number?]|string>} colors sampled colours (RGBA arrays or CSS strings)
 * @param {{ fuzziness?: number }} [options] 0..200
 * @param {Rect|null} [rect]
 * @returns {Mask}
 */
export function colorRange(img, colors, { fuzziness = 40 } = {}, rect = null) {
  const w = img.width, h = img.height, d = img.data;
  const mask = new Uint8ClampedArray(w * h);
  const r = clampRect(rect, w, h);
  let list = Array.isArray(colors) ? colors : [colors];
  if (list.length && typeof list[0] === 'number') list = [list];
  const n = list.length;
  if (!n || r.width <= 0) return mask;
  const cs = new Int32Array(n * 3);
  for (let k = 0; k < n; k++) {
    const c = parseColor(list[k]);
    cs[k * 3] = Math.round(c[0]);
    cs[k * 3 + 1] = Math.round(c[1]);
    cs[k * 3 + 2] = Math.round(c[2]);
  }
  const f = clampNum(+fuzziness || 0, 0, 200);
  const half = f / 2;
  const lut = makeLut((dist) => (f <= 0 ? (dist === 0 ? 255 : 0) : dist <= half ? 255 : dist >= f ? 0 : (255 * (f - dist)) / half));
  const cn = cs.length;
  for (let yy = r.y, ye = r.y + r.height; yy < ye; yy++) {
    let i = yy * w + r.x, p = i * 4;
    for (let xx = 0; xx < r.width; xx++, i++, p += 4) {
      const a = d[p + 3];
      if (a === 0) continue;
      const pr = d[p], pg = d[p + 1], pb = d[p + 2];
      let best = 255;
      for (let k = 0; k < cn; k += 3) {
        let m = pr - cs[k];
        if (m < 0) m = -m;
        let t = pg - cs[k + 1];
        if (t < 0) t = -t;
        if (t > m) m = t;
        t = pb - cs[k + 2];
        if (t < 0) t = -t;
        if (t > m) m = t;
        if (m < best) best = m;
      }
      const v = lut[best];
      mask[i] = a === 255 ? v : Math.round((v * a) / 255);
    }
  }
  return mask;
}

// ---------------------------------------------------------------------------------------------
// Mask basics
// ---------------------------------------------------------------------------------------------

/**
 * Mask from the image's alpha channel (coverage = alpha); pixels outside rect are 0.
 * @param {ImageDataLike} img @param {Rect|null} [rect] @returns {Mask}
 */
export function maskFromAlpha(img, rect = null) {
  const w = img.width, h = img.height, d = img.data;
  const mask = new Uint8ClampedArray(w * h);
  const r = clampRect(rect, w, h);
  for (let yy = r.y, ye = r.y + r.height; yy < ye; yy++) {
    let i = yy * w + r.x, p = i * 4 + 3;
    for (let xx = 0; xx < r.width; xx++, i++, p += 4) mask[i] = d[p];
  }
  return mask;
}

/**
 * Bounding box of the pixels with coverage > 0 (inside rect), or null when the mask is empty.
 * @param {Mask} mask @param {number} w @param {number} h @param {Rect|null} [rect] @returns {Rect|null}
 */
export function maskBounds(mask, w, h, rect = null) {
  const r = clampRect(rect, w, h);
  let x1 = w, y1 = h, x2 = -1, y2 = -1;
  const xe = r.x + r.width;
  for (let y = r.y, ye = r.y + r.height; y < ye; y++) {
    const row = y * w;
    let xs = r.x;
    while (xs < xe && mask[row + xs] === 0) xs++;
    if (xs === xe) continue;
    let xl = xe - 1;
    while (mask[row + xl] === 0) xl--;
    if (xs < x1) x1 = xs;
    if (xl > x2) x2 = xl;
    if (y < y1) y1 = y;
    y2 = y;
  }
  return x2 < 0 ? null : { x: x1, y: y1, width: x2 - x1 + 1, height: y2 - y1 + 1 };
}

const COMBINE_MODES = { replace: 0, add: 1, subtract: 2, intersect: 3 };

/** Writes combine(a[i], b[i]) into out[i] for i in [from, to) (b missing beyond its length = 0). */
function combineRange(a, b, out, op, from, to) {
  const m = to < b.length ? to : b.length;
  let i = from;
  if (op === 0) for (; i < m; i++) out[i] = b[i];
  else if (op === 1) for (; i < m; i++) out[i] = a[i] > b[i] ? a[i] : b[i];
  else if (op === 2) {
    for (; i < m; i++) {
      const inv = 255 - b[i];
      out[i] = a[i] < inv ? a[i] : inv;
    }
  } else for (; i < m; i++) out[i] = a[i] < b[i] ? a[i] : b[i];
  // Past the end of b: b counts as 0 (replace/intersect -> 0, add/subtract -> a).
  for (; i < to; i++) out[i] = op === 1 || op === 2 ? a[i] : 0;
}

/**
 * Combines two masks of the same size into a new one. Soft coverage is combined with max/min so
 * feathered edges keep their shape: 'replace' -> b, 'add' -> max(a, b), 'subtract' -> min(a, 255 - b),
 * 'intersect' -> min(a, b). With (w, h, rect) only the pixels inside rect are combined; the others
 * keep a's coverage.
 * @param {Mask} a @param {Mask} b @param {'replace'|'add'|'subtract'|'intersect'} [mode]
 * @param {number} [w] @param {number} [h] @param {Rect|null} [rect] needs w and h
 * @returns {Mask}
 */
export function combineMasks(a, b, mode = 'replace', w = 0, h = 0, rect = null) {
  const op = COMBINE_MODES[mode];
  if (op === undefined) throw new RangeError(`combineMasks: unknown mode "${mode}"`);
  const n = a.length;
  if (!rect || !(w > 0)) {
    const out = new Uint8ClampedArray(n);
    combineRange(a, b, out, op, 0, n);
    return out;
  }
  const out = new Uint8ClampedArray(a);
  const r = clampRect(rect, w, h);
  for (let y = r.y, ye = r.y + r.height; y < ye; y++) {
    const i = y * w + r.x;
    combineRange(a, b, out, op, i, i + r.width);
  }
  return out;
}

/**
 * Returns a new mask with coverage inverted (255 - v). With (w, h, rect) only the pixels inside rect
 * are inverted; the others are copied.
 * @param {Mask} mask @param {number} [w] @param {number} [h] @param {Rect|null} [rect] needs w and h
 * @returns {Mask}
 */
export function invertMask(mask, w = 0, h = 0, rect = null) {
  const n = mask.length;
  if (!rect || !(w > 0)) {
    const out = new Uint8ClampedArray(n);
    for (let i = 0; i < n; i++) out[i] = 255 - mask[i];
    return out;
  }
  const out = new Uint8ClampedArray(mask);
  const r = clampRect(rect, w, h);
  for (let y = r.y, ye = r.y + r.height; y < ye; y++) {
    for (let i = y * w + r.x, e = i + r.width; i < e; i++) out[i] = 255 - mask[i];
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Feather, expand, contract, border, smooth
// ---------------------------------------------------------------------------------------------

const FEATHER_PASSES = 3;

/**
 * Extended box filter (Gwosdek et al. 2011): integer radius r plus end taps of weight alpha, chosen so
 * that `passes` successive passes have exactly variance sigma^2 (no jumps as the radius changes).
 */
function extendedBox(sigma, passes) {
  const s = (sigma * sigma) / passes;
  const r = Math.max(0, Math.floor(0.5 * Math.sqrt(12 * s + 1) - 0.5));
  const alpha = ((2 * r + 1) * (3 * s - r * (r + 1))) / (6 * ((r + 1) * (r + 1) - s));
  return { r, alpha, inv: 1 / (2 * r + 1 + 2 * alpha) };
}

/** One extended-box pass along a line of n values (zero beyond both ends), O(n) whatever r. */
function boxPassLine(src, dst, n, r, alpha, inv) {
  let s = 0;
  for (let k = 0, e = r < n ? r : n - 1; k <= e; k++) s += src[k];
  for (let i = 0; i < n; i++) {
    const a = i - r - 1, b = i + r + 1;
    const vb = b < n ? src[b] : 0;
    dst[i] = (s + alpha * ((a >= 0 ? src[a] : 0) + vb)) * inv;
    if (i >= r) s -= src[i - r];
    s += vb;
  }
}

/** One extended-box pass down the columns of a rows x cw buffer (zero above and below), row-major. */
function boxPassCols(src, dst, rows, cw, r, alpha, inv, sum) {
  sum.fill(0);
  for (let k = 0, e = r < rows ? r : rows - 1; k <= e; k++) {
    const o = k * cw;
    for (let x = 0; x < cw; x++) sum[x] += src[o + x];
  }
  for (let y = 0; y < rows; y++) {
    const o = y * cw, a = y - r - 1, b = y + r + 1, oa = a * cw, ob = b * cw;
    if (a >= 0 && b < rows) for (let x = 0; x < cw; x++) dst[o + x] = (sum[x] + alpha * (src[oa + x] + src[ob + x])) * inv;
    else if (a >= 0) for (let x = 0; x < cw; x++) dst[o + x] = (sum[x] + alpha * src[oa + x]) * inv;
    else if (b < rows) for (let x = 0; x < cw; x++) dst[o + x] = (sum[x] + alpha * src[ob + x]) * inv;
    else for (let x = 0; x < cw; x++) dst[o + x] = sum[x] * inv;
    if (y >= r) {
      const od = (y - r) * cw;
      for (let x = 0; x < cw; x++) sum[x] -= src[od + x];
    }
    if (b < rows) for (let x = 0; x < cw; x++) sum[x] += src[ob + x];
  }
}

/**
 * Feathers a mask IN PLACE with a gaussian of sigma = radius / 2, computed as three separable
 * extended-box passes (exact variance, constant time per pixel whatever the radius). Outside the
 * canvas counts as unselected, so a selection touching the canvas edge fades there. Total coverage of
 * shapes away from the edges is preserved (up to rounding).
 * @param {Mask} mask modified in place
 * @param {number} w @param {number} h @param {number} radius px (<= 0 = unchanged)
 * @param {Rect|null} [rect] only pixels inside are rewritten (they still see neighbours outside it)
 * @returns {Mask} the same `mask` array
 */
export function feather(mask, w, h, radius, rect = null) {
  const r = clampRect(rect, w, h);
  const sigma = radius / 2;
  if (r.width <= 0 || !(sigma > 0)) return mask;
  const { r: br, alpha, inv } = extendedBox(sigma, FEATHER_PASSES);
  // Each pass reads br + 1 pixels on each side; values more than `ext` away from a buffer edge that is
  // not the canvas edge are exact, so the working region is the rect grown by ext (clipped).
  const ext = FEATHER_PASSES * (br + 1);
  const cx0 = Math.max(0, r.x - ext), cx1 = Math.min(w, r.x + r.width + ext), cw = cx1 - cx0;
  const ry0 = Math.max(0, r.y - ext), ry1 = Math.min(h, r.y + r.height + ext), rows = ry1 - ry0;
  const rw = r.width, sx = r.x - cx0;
  let bufA = new Float32Array(rows * rw), bufB = new Float32Array(rows * rw);
  const la = new Float32Array(cw), lb = new Float32Array(cw);
  for (let y = ry0; y < ry1; y++) {
    const off = y * w + cx0;
    let any = 0;
    for (let x = 0; x < cw; x++) {
      const v = mask[off + x];
      la[x] = v;
      any |= v;
    }
    if (!any) continue; // an empty row stays empty after the horizontal passes
    boxPassLine(la, lb, cw, br, alpha, inv);
    boxPassLine(lb, la, cw, br, alpha, inv);
    boxPassLine(la, lb, cw, br, alpha, inv);
    bufA.set(lb.subarray(sx, sx + rw), (y - ry0) * rw);
  }
  const sum = new Float64Array(rw);
  for (let p = 0; p < FEATHER_PASSES; p++) {
    boxPassCols(bufA, bufB, rows, rw, br, alpha, inv, sum);
    const t = bufA;
    bufA = bufB;
    bufB = t;
  }
  for (let y = r.y, ye = r.y + r.height; y < ye; y++) {
    const o = (y - ry0) * rw, mo = y * w + r.x;
    for (let x = 0; x < rw; x++) mask[mo + x] = bufA[o + x]; // Uint8ClampedArray rounds and clamps
  }
  return mask;
}

/**
 * dst[x] = max(src[x-hw .. x+hw]) with the window clipped to [0, w) (van Herk / Gil-Werman, O(w)).
 * g and hh are scratch Uint8Arrays of length w.
 */
function runMax(src, w, hw, dst, g, hh) {
  if (hw <= 0) {
    dst.set(src.subarray(0, w));
    return;
  }
  const k = 2 * hw + 1;
  for (let x = 0, c = 0; x < w; x++, c++) {
    if (c === k) c = 0;
    const v = src[x];
    g[x] = c === 0 || v > g[x - 1] ? v : g[x - 1];
  }
  for (let x = w - 1, pos = (w - 1) % k; x >= 0; x--) {
    const v = src[x];
    hh[x] = pos === k - 1 || x === w - 1 || v > hh[x + 1] ? v : hh[x + 1];
    pos = pos === 0 ? k - 1 : pos - 1;
  }
  for (let x = 0; x < w; x++) {
    let a = x - hw, b = x + hw;
    if (a < 0) a = 0;
    if (b >= w) b = w - 1;
    const ba = (a / k) | 0, bb = (b / k) | 0;
    if (ba !== bb) {
      const u = hh[a], v = g[b];
      dst[x] = u > v ? u : v;
    } else dst[x] = a === ba * k ? g[b] : hh[a];
  }
}

/**
 * Grey-level dilation of the mask with a disc of the given radius (offsets with dx^2 + dy^2 <= r^2),
 * replicating edge pixels. Rows are processed with per-band horizontal max filters, O(n * radius).
 */
function discMax(mask, w, h, radius, rect) {
  const out = new Uint8ClampedArray(mask);
  const r = clampRect(rect, w, h);
  const R = Math.floor(radius);
  if (r.width <= 0 || !(radius >= 1)) return out;
  // Group the rows of the disc by their half-width (bands of equal hw share one horizontal filter).
  const bandHw = [], bandFrom = [], bandTo = [];
  for (let dy = 0; dy <= R; dy++) {
    const hw = Math.floor(Math.sqrt(radius * radius - dy * dy));
    if (bandHw.length && bandHw[bandHw.length - 1] === hw) bandTo[bandTo.length - 1] = dy;
    else {
      bandHw.push(hw);
      bandFrom.push(dy);
      bandTo.push(dy);
    }
  }
  const acc = new Uint8Array(w), tmp = new Uint8Array(w), g = new Uint8Array(w), hh = new Uint8Array(w), rowOut = new Uint8Array(w);
  const x0 = r.x, x1 = r.x + r.width;
  for (let y = r.y, ye = r.y + r.height; y < ye; y++) {
    rowOut.fill(0, x0, x1);
    for (let bnd = 0; bnd < bandHw.length; bnd++) {
      let any = false;
      for (let s = -1; s <= 1; s += 2) {
        for (let dy = bandFrom[bnd]; dy <= bandTo[bnd]; dy++) {
          if (dy === 0 && s === 1) continue;
          const yy = y + s * dy;
          if (yy < 0 || yy >= h) continue;
          const off = yy * w;
          if (!any) {
            acc.set(mask.subarray(off, off + w));
            any = true;
          } else {
            for (let x = 0; x < w; x++) {
              const v = mask[off + x];
              if (v > acc[x]) acc[x] = v;
            }
          }
        }
      }
      if (!any) continue;
      const src = bandHw[bnd] === 0 ? acc : (runMax(acc, w, bandHw[bnd], tmp, g, hh), tmp);
      for (let x = x0; x < x1; x++) if (src[x] > rowOut[x]) rowOut[x] = src[x];
    }
    out.set(rowOut.subarray(x0, x1), y * w + x0);
  }
  return out;
}

/**
 * Expands the selection by px: morphological dilation with a disc (dx^2 + dy^2 <= px^2), a max filter
 * so soft edges are preserved. Expanding a 3x3 square by 1 gives a 5x5 square minus its 4 corners
 * (21 pixels). Edge pixels are replicated at the canvas bounds.
 * @param {Mask} mask @param {number} w @param {number} h @param {number} px >= 1 (less = copy) @param {Rect|null} [rect]
 * @returns {Mask}
 */
export function expand(mask, w, h, px, rect = null) {
  return discMax(mask, w, h, px, rect);
}

/**
 * Contracts the selection by px: morphological erosion with the same disc as expand() (min filter,
 * soft edges preserved). A selection touching the canvas edge keeps touching it.
 * @param {Mask} mask @param {number} w @param {number} h @param {number} px >= 1 (less = copy) @param {Rect|null} [rect]
 * @returns {Mask}
 */
export function contract(mask, w, h, px, rect = null) {
  if (!(px >= 1)) return new Uint8ClampedArray(mask);
  return invertMask(discMax(invertMask(mask), w, h, px, rect));
}

/**
 * Border selection of width px: the pixels gained by expanding by ceil(px / 2) minus those kept after
 * contracting by floor(px / 2) (coverage = expanded - contracted, so soft edges stay soft). px < 1
 * gives an empty mask.
 * @param {Mask} mask @param {number} w @param {number} h @param {number} px @param {Rect|null} [rect]
 * @returns {Mask}
 */
export function border(mask, w, h, px, rect = null) {
  if (!(px >= 1)) return new Uint8ClampedArray(mask.length);
  const outer = expand(mask, w, h, Math.ceil(px / 2), rect);
  const inner = contract(mask, w, h, Math.floor(px / 2), rect);
  const r = clampRect(rect, w, h);
  const out = new Uint8ClampedArray(mask.length);
  for (let y = r.y, ye = r.y + r.height; y < ye; y++) {
    for (let i = y * w + r.x, e = i + r.width; i < e; i++) {
      const v = outer[i] - inner[i];
      out[i] = v > 0 ? v : 0;
    }
  }
  return out;
}

/**
 * Box mean of the mask over a (2 rad + 1)^2 window, normalised by the in-canvas pixel count, for the
 * pixels in r. Returns Float32Array(r.width * r.height) with values 0..255.
 */
function boxMean(mask, w, h, rad, r) {
  const rw = r.width, rh = r.height;
  const ry0 = Math.max(0, r.y - rad), ry1 = Math.min(h, r.y + rh + rad);
  const rows = ry1 - ry0;
  const tmp = new Float32Array(rows * rw);
  for (let yy = ry0; yy < ry1; yy++) {
    const row = yy * w, trow = (yy - ry0) * rw;
    let xa = r.x - rad, xb = r.x + rad;
    let sum = 0, cnt = 0;
    for (let x = xa < 0 ? 0 : xa, e = xb >= w ? w - 1 : xb; x <= e; x++) {
      sum += mask[row + x];
      cnt++;
    }
    for (let xx = 0; xx < rw; xx++) {
      tmp[trow + xx] = sum / cnt;
      if (xa >= 0) {
        sum -= mask[row + xa];
        cnt--;
      }
      xa++;
      xb++;
      if (xb < w) {
        sum += mask[row + xb];
        cnt++;
      }
    }
  }
  const out = new Float32Array(rw * rh);
  const colSum = new Float32Array(rw);
  let ya = r.y - rad, yb = r.y + rad, cnt = 0;
  for (let yy = ya < ry0 ? ry0 : ya, e = yb >= ry1 ? ry1 - 1 : yb; yy <= e; yy++) {
    const trow = (yy - ry0) * rw;
    for (let xx = 0; xx < rw; xx++) colSum[xx] += tmp[trow + xx];
    cnt++;
  }
  for (let y = 0; y < rh; y++) {
    const orow = y * rw;
    for (let xx = 0; xx < rw; xx++) out[orow + xx] = colSum[xx] / cnt;
    if (ya >= ry0) {
      const trow = (ya - ry0) * rw;
      for (let xx = 0; xx < rw; xx++) colSum[xx] -= tmp[trow + xx];
      cnt--;
    }
    ya++;
    yb++;
    if (yb < ry1) {
      const trow = (yb - ry0) * rw;
      for (let xx = 0; xx < rw; xx++) colSum[xx] += tmp[trow + xx];
      cnt++;
    }
  }
  return out;
}

/**
 * Smooths the selection (median-like): a box blur of the given radius followed by a steep threshold at
 * 50% whose ramp spans exactly one blur step, so straight edges are preserved, stray pixels and small
 * holes vanish, corners round off and the result keeps a 1px antialiased edge.
 * @param {Mask} mask @param {number} w @param {number} h @param {number} radius >= 1 (less = copy) @param {Rect|null} [rect]
 * @returns {Mask}
 */
export function smooth(mask, w, h, radius, rect = null) {
  const out = new Uint8ClampedArray(mask);
  const r = clampRect(rect, w, h);
  const rad = Math.floor(radius);
  if (r.width <= 0 || !(rad >= 1)) return out;
  const mean = boxMean(mask, w, h, rad, r);
  const k = 2 * rad + 1;
  for (let y = 0; y < r.height; y++) {
    const orow = (r.y + y) * w + r.x, mrow = y * r.width;
    for (let xx = 0; xx < r.width; xx++) {
      const v = (mean[mrow + xx] - 127.5) * k + 127.5;
      out[orow + xx] = v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Grow / Similar
// ---------------------------------------------------------------------------------------------

/** 1-D dilation (Chebyshev radius dq) of the 64^3 occupancy LUT along one axis, in place. */
function dilateLutAxis(occ, stride, dq) {
  const s1 = stride === 1 ? 64 : 1, s2 = stride === 4096 ? 64 : 4096;
  const line = new Uint8Array(64);
  for (let i = 0; i < 64; i++) {
    for (let j = 0; j < 64; j++) {
      const base = i * s1 + j * s2;
      let last = -1000;
      for (let k = 0; k < 64; k++) {
        if (occ[base + k * stride]) last = k;
        line[k] = k - last <= dq ? 1 : 0;
      }
      last = 1000;
      for (let k = 63; k >= 0; k--) {
        if (occ[base + k * stride]) last = k;
        if (last - k <= dq) line[k] = 1;
      }
      for (let k = 0; k < 64; k++) occ[base + k * stride] = line[k];
    }
  }
}

/**
 * Builds a 6-bit-per-channel RGB lookup (64^3 entries) marking every colour within `tol` (max channel
 * difference, at +-4 levels of quantisation) of a colour found under the selection (mask >= 128), plus
 * the selected alpha range widened by tol. Returns null when nothing is selected.
 */
function colorLutFromMask(img, mask, tol, r) {
  const d = img.data, w = img.width;
  const occ = new Uint8Array(1 << 18);
  let aMin = 255, aMax = 0, count = 0;
  for (let yy = r.y, ye = r.y + r.height; yy < ye; yy++) {
    let i = yy * w + r.x, p = i * 4;
    for (let xx = 0; xx < r.width; xx++, i++, p += 4) {
      if (mask[i] < 128) continue;
      occ[((d[p] >> 2) << 12) | ((d[p + 1] >> 2) << 6) | (d[p + 2] >> 2)] = 1;
      const a = d[p + 3];
      if (a < aMin) aMin = a;
      if (a > aMax) aMax = a;
      count++;
    }
  }
  if (!count) return null;
  const dq = Math.ceil(tol / 4);
  if (dq > 0) {
    dilateLutAxis(occ, 1, dq);
    dilateLutAxis(occ, 64, dq);
    dilateLutAxis(occ, 4096, dq);
  }
  return { lut: occ, aMin: Math.max(0, aMin - tol), aMax: Math.min(255, aMax + tol) };
}

/** Marks (255) every pixel in r whose colour matches the LUT (and alpha range), 1 elsewhere. */
function matchFromLut(img, info, r, includeMask) {
  const d = img.data, w = img.width, h = img.height;
  const { lut, aMin, aMax } = info;
  const match = new Uint8Array(w * h).fill(1);
  for (let yy = r.y, ye = r.y + r.height; yy < ye; yy++) {
    let i = yy * w + r.x, p = i * 4;
    for (let xx = 0; xx < r.width; xx++, i++, p += 4) {
      if (includeMask && includeMask[i] >= 128) {
        match[i] = 255;
        continue;
      }
      const a = d[p + 3];
      if (a >= aMin && a <= aMax && lut[((d[p] >> 2) << 12) | ((d[p + 1] >> 2) << 6) | (d[p + 2] >> 2)]) match[i] = 255;
    }
  }
  return match;
}

/**
 * Grow: adds the pixels 4-connected to the selection whose colour is within `tolerance` of a colour
 * found under the selection (colours matched at 6-bit precision; alpha must lie within the selected
 * alpha range widened by the tolerance). Added pixels get full coverage; existing coverage is kept.
 * @param {ImageDataLike} img @param {Mask} mask @param {{ tolerance?: number }} [options] @param {Rect|null} [rect]
 * @returns {Mask}
 */
export function grow(img, mask, { tolerance = 32 } = {}, rect = null) {
  const w = img.width, h = img.height;
  const out = new Uint8ClampedArray(mask);
  const r = clampRect(rect, w, h);
  if (r.width <= 0) return out;
  const info = colorLutFromMask(img, mask, clampNum(Math.round(tolerance) || 0, 0, 255), r);
  if (!info) return out;
  const match = matchFromLut(img, info, r, mask);
  const region = new Uint8ClampedArray(w * h);
  for (let yy = r.y, ye = r.y + r.height; yy < ye; yy++) {
    let i = yy * w + r.x;
    for (let xx = r.x, xe = r.x + r.width; xx < xe; xx++, i++) {
      if (mask[i] >= 128 && region[i] === 0) scanlineFill(match, noProbe, w, r, xx, yy, region);
    }
  }
  for (let yy = r.y, ye = r.y + r.height; yy < ye; yy++) {
    for (let i = yy * w + r.x, e = i + r.width; i < e; i++) if (region[i] > out[i]) out[i] = region[i];
  }
  return out;
}

/**
 * Similar: adds every pixel in the rect (contiguous or not) whose colour is within `tolerance` of a
 * colour found under the selection; same matching rules as grow().
 * @param {ImageDataLike} img @param {Mask} mask @param {{ tolerance?: number }} [options] @param {Rect|null} [rect]
 * @returns {Mask}
 */
export function similar(img, mask, { tolerance = 32 } = {}, rect = null) {
  const w = img.width, h = img.height;
  const out = new Uint8ClampedArray(mask);
  const r = clampRect(rect, w, h);
  if (r.width <= 0) return out;
  const info = colorLutFromMask(img, mask, clampNum(Math.round(tolerance) || 0, 0, 255), r);
  if (!info) return out;
  const match = matchFromLut(img, info, r, null);
  for (let yy = r.y, ye = r.y + r.height; yy < ye; yy++) {
    for (let i = yy * w + r.x, e = i + r.width; i < e; i++) if (match[i] === 255) out[i] = 255;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Outline (boundary following) and rasterisation
// ---------------------------------------------------------------------------------------------

const DX = [1, 0, -1, 0], DY = [0, 1, 0, -1]; // direction of a top / right / bottom / left edge

/**
 * Follows one boundary loop starting at the given edge (pixel index, side 0..3), clearing the edge
 * bits it consumes. Returns the loop's corner vertices (collinear points merged).
 */
function traceLoop(bits, w, h, px, py, side, startIdx) {
  const pts = [];
  let vx = side === 0 || side === 3 ? px : px + 1;
  let vy = side <= 1 ? py : py + 1;
  pts.push([vx, vy]);
  let p = startIdx, s = side, dir = side;
  for (;;) {
    bits[p] &= ~(1 << s);
    vx += DX[dir];
    vy += DY[dir];
    let found = -1, np = 0;
    // Prefer the right turn, then straight, then the left turn: diagonal neighbours stay separate.
    for (let t = 0; t < 3; t++) {
      const nd = (dir + (t === 0 ? 1 : t === 1 ? 0 : 3)) & 3;
      const qx = nd === 1 || nd === 2 ? vx - 1 : vx;
      const qy = nd >= 2 ? vy - 1 : vy;
      if (qx < 0 || qy < 0 || qx >= w || qy >= h) continue;
      const q = qy * w + qx;
      if (q === startIdx && nd === side) {
        found = -2;
        break;
      }
      if (bits[q] & (1 << nd)) {
        found = nd;
        np = q;
        break;
      }
    }
    if (found === -2) {
      if (dir === side) pts.shift();
      return pts;
    }
    if (found < 0) return pts; // cannot happen for a consistent edge set
    if (found !== dir) pts.push([vx, vy]);
    p = np;
    s = found;
    dir = found;
  }
}

/**
 * Traces the boundary of the pixels with coverage >= threshold as closed polygons in pixel-corner
 * coordinates (0..w, 0..h). Each loop is a list of corner points (no collinear or duplicate
 * consecutive points), so the sum of its edge lengths equals the number of unit boundary edges it
 * covers. Outer boundaries run clockwise on screen (positive shoelace area with y down), holes
 * counter-clockwise; regions touching only diagonally give separate loops (4-connectivity). Pixels
 * outside rect count as unselected.
 * @param {Mask} mask @param {number} w @param {number} h @param {number} [threshold=128] @param {Rect|null} [rect]
 * @returns {Array<Array<[number, number]>>}
 */
export function outline(mask, w, h, threshold = 128, rect = null) {
  const polys = [];
  const r = clampRect(rect, w, h);
  if (r.width <= 0) return polys;
  const x0 = r.x, y0 = r.y, x1 = r.x + r.width, y1 = r.y + r.height;
  const bits = new Uint8Array(w * h);
  for (let y = y0; y < y1; y++) {
    let i = y * w + x0;
    for (let x = x0; x < x1; x++, i++) {
      if (mask[i] < threshold) continue;
      let b = 0;
      if (y === y0 || mask[i - w] < threshold) b |= 1;
      if (x === x1 - 1 || mask[i + 1] < threshold) b |= 2;
      if (y === y1 - 1 || mask[i + w] < threshold) b |= 4;
      if (x === x0 || mask[i - 1] < threshold) b |= 8;
      bits[i] = b;
    }
  }
  for (let y = y0; y < y1; y++) {
    let i = y * w + x0;
    for (let x = x0; x < x1; x++, i++) {
      while (bits[i]) {
        const b = bits[i];
        const side = b & 1 ? 0 : b & 2 ? 1 : b & 4 ? 2 : 3;
        polys.push(traceLoop(bits, w, h, x, y, side, i));
      }
    }
  }
  return polys;
}

/** Accumulates fractional horizontal coverage of span [xa, xb) (rect-relative, clipped) with weight wgt. */
function addSpanCoverage(cov, diff, xa, xb, wgt, width) {
  const ia = Math.floor(xa), ib = Math.floor(xb);
  if (ia === ib) {
    cov[ia] += (xb - xa) * wgt;
    return;
  }
  cov[ia] += (ia + 1 - xa) * wgt;
  if (ib < width) cov[ib] += (xb - ib) * wgt;
  diff[ia + 1] += wgt;
  diff[ib] -= wgt;
}

/** Marks the pixels whose centre lies in [xa, xb) (rect-relative, clipped) as fully covered. */
function addSpanCentre(diff, xa, xb, width) {
  let ia = Math.ceil(xa - 0.5), ib = Math.ceil(xb - 0.5);
  if (ia < 0) ia = 0;
  if (ib > width) ib = width;
  if (ib > ia) {
    diff[ia] += 1;
    diff[ib] -= 1;
  }
}

/** Writes one accumulated row (partial coverage + interior runs) into the mask. */
function resolveRow(mask, off, cov, diff, width) {
  let run = 0;
  for (let x = 0; x < width; x++) {
    run += diff[x];
    const v = cov[x] + run;
    mask[off + x] = v <= 0 ? 0 : Math.round(v * 255);
  }
}

/** Normalises polygon input into a list of flat [x0, y0, x1, y1, ...] arrays. */
function flatPolygons(points) {
  if (!points || !points.length) return [];
  const flatten = (poly) => {
    if (!poly || !poly.length) return [];
    if (typeof poly[0] === 'number') return poly;
    const out = new Float64Array(poly.length * 2);
    for (let i = 0; i < poly.length; i++) {
      out[i * 2] = poly[i][0];
      out[i * 2 + 1] = poly[i][1];
    }
    return out;
  };
  if (typeof points[0] === 'number' || typeof points[0][0] === 'number') return [flatten(points)];
  return points.map(flatten);
}

/**
 * Rasterises a polygon (even-odd rule) given in pixel-corner coordinates: `points` is [[x, y], ...], a
 * flat [x0, y0, x1, y1, ...] array, or a list of such polygons (holes and islands, e.g. the result of
 * outline()). Antialiasing uses `samples` sub-scanlines per pixel row with exact horizontal coverage
 * (default 4, i.e. 4x4-equivalent supersampling); otherwise pixels are tested at their centres.
 * @param {Array<[number, number]>|number[]|Array<Array<[number, number]>>} points
 * @param {number} w @param {number} h
 * @param {{ antialias?: boolean, samples?: number }} [options]
 * @param {Rect|null} [rect] clip; pixels outside are 0
 * @returns {Mask}
 */
export function rasterizePolygon(points, w, h, { antialias = true, samples = 4 } = {}, rect = null) {
  const mask = new Uint8ClampedArray(w * h);
  const r = clampRect(rect, w, h);
  if (r.width <= 0) return mask;
  const polys = flatPolygons(points);
  let total = 0;
  for (const poly of polys) total += poly.length >> 1;
  const ex0 = new Float64Array(total), ey0 = new Float64Array(total), ey1 = new Float64Array(total), slope = new Float64Array(total);
  let n = 0, minY = Infinity, maxY = -Infinity;
  for (const poly of polys) {
    const m = poly.length >> 1;
    if (m < 2) continue;
    for (let i = 0; i < m; i++) {
      const j = (i + 1) % m;
      let xa = poly[i * 2], ya = poly[i * 2 + 1], xb = poly[j * 2], yb = poly[j * 2 + 1];
      if (!(ya !== yb) || !Number.isFinite(xa + ya + xb + yb)) continue; // horizontal or invalid
      if (ya > yb) {
        let t = xa;
        xa = xb;
        xb = t;
        t = ya;
        ya = yb;
        yb = t;
      }
      ex0[n] = xa;
      ey0[n] = ya;
      ey1[n] = yb;
      slope[n] = (xb - xa) / (yb - ya);
      if (ya < minY) minY = ya;
      if (yb > maxY) maxY = yb;
      n++;
    }
  }
  if (!n) return mask;
  const order = new Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  order.sort((a, b) => ey0[a] - ey0[b]);
  const yStart = Math.max(r.y, Math.floor(minY)), yEnd = Math.min(r.y + r.height, Math.ceil(maxY));
  if (yStart >= yEnd) return mask;
  const S = antialias ? Math.max(1, samples | 0) : 1, wgt = 1 / S;
  const width = r.width;
  const cov = new Float32Array(width), diff = new Float32Array(width + 1);
  const xs = new Float64Array(n);
  const active = [];
  let next = 0;
  for (let y = yStart; y < yEnd; y++) {
    cov.fill(0);
    diff.fill(0);
    let touched = false;
    for (let s = 0; s < S; s++) {
      const ys = y + (s + 0.5) / S;
      while (next < n && ey0[order[next]] <= ys) active.push(order[next++]);
      let m = 0, keep = 0;
      for (let k = 0; k < active.length; k++) {
        const e = active[k];
        if (ey1[e] <= ys) continue;
        active[keep++] = e;
        xs[m++] = ex0[e] + (ys - ey0[e]) * slope[e];
      }
      active.length = keep;
      if (m < 2) continue;
      const sorted = xs.subarray(0, m).sort();
      for (let k = 0; k + 1 < m; k += 2) {
        let xa = sorted[k] - r.x, xb = sorted[k + 1] - r.x;
        if (xa < 0) xa = 0;
        if (xb > width) xb = width;
        if (xb <= xa) continue;
        touched = true;
        if (antialias) addSpanCoverage(cov, diff, xa, xb, wgt, width);
        else addSpanCentre(diff, xa, xb, width);
      }
    }
    if (touched) resolveRow(mask, y * w + r.x, cov, diff, width);
  }
  return mask;
}

/**
 * Rasterises the ellipse inscribed in `rect` (pixel-corner coordinates, may be fractional). With
 * antialiasing, each pixel row is sampled on `samples` sub-scanlines (default 16) with exact
 * horizontal coverage; otherwise pixels are tested at their centres.
 * @param {Rect} rect ellipse bounds @param {number} w @param {number} h
 * @param {{ antialias?: boolean, samples?: number }} [options]
 * @param {Rect|null} [clip] pixels outside are 0
 * @returns {Mask}
 */
export function rasterizeEllipse(rect, w, h, { antialias = true, samples = 16 } = {}, clip = null) {
  const mask = new Uint8ClampedArray(w * h);
  const r = clampRect(clip, w, h);
  if (r.width <= 0 || !rect || !(rect.width > 0) || !(rect.height > 0)) return mask;
  const a = rect.width / 2, b = rect.height / 2, cx = rect.x + a, cy = rect.y + b;
  const yStart = Math.max(r.y, Math.floor(rect.y)), yEnd = Math.min(r.y + r.height, Math.ceil(rect.y + rect.height));
  if (yStart >= yEnd) return mask;
  const S = antialias ? Math.max(1, samples | 0) : 1, wgt = 1 / S;
  const width = r.width;
  const cov = new Float32Array(width), diff = new Float32Array(width + 1);
  for (let y = yStart; y < yEnd; y++) {
    cov.fill(0);
    diff.fill(0);
    let touched = false;
    for (let s = 0; s < S; s++) {
      const t = (y + (s + 0.5) / S - cy) / b;
      if (t <= -1 || t >= 1) continue;
      const hx = a * Math.sqrt(1 - t * t);
      let xa = cx - hx - r.x, xb = cx + hx - r.x;
      if (xa < 0) xa = 0;
      if (xb > width) xb = width;
      if (xb <= xa) continue;
      touched = true;
      if (antialias) addSpanCoverage(cov, diff, xa, xb, wgt, width);
      else addSpanCentre(diff, xa, xb, width);
    }
    if (touched) resolveRow(mask, y * w + r.x, cov, diff, width);
  }
  return mask;
}
