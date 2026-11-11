// Seam carving (builder "content-aware-lens"): the pixel side of Edit > Content-Aware Scale.
// Pure, no DOM: ImageDataLike in ({ width, height, data: Uint8ClampedArray RGBA, straight alpha }), new images out.
//
// A seam is an 8-connected path of one pixel per row (vertical seam) or per column (horizontal seam) with
// the lowest total energy; removing it narrows the image by one pixel where it matters least. Energy is the
// colour gradient magnitude plus weights: `protect` (a width*height mask, 255 = never cut here unless nothing
// else is left), `remove` (255 = cut here first) and `skin` (a YCbCr skin-tone detector that adds protection).
//
// The naive loop (find a seam, remove it, repeat) costs width*height per seam, which is seconds per drag
// step on a real layer. Instead a **seam map** is built once per axis: order[y][x] = the rank at which the
// pixel's seam is removed. Scaling to any size is then a lookup (drop the pixels whose rank is below the
// number of seams to remove, or duplicate them to widen), which is what makes the on-canvas drag
// interactive. The map itself is built in passes: one dynamic-programming sweep yields a batch of disjoint
// low-cost seams (not just one), so a full map costs a few dozen sweeps instead of `width` of them, and
// each pass is one bounded step (about 50 ms on 2000x1500), so the caller can interleave them with frames.

import { createImage } from './core.js';
import { resize } from './transform.js';

/** @typedef {import('./core.js').ImageDataLike} ImageDataLike */
/** @typedef {{ width: number, height: number, data: Float32Array }} EnergyMap */
/** @typedef {{ protect?: Uint8ClampedArray | Uint8Array | null, remove?: Uint8ClampedArray | Uint8Array | null, skin?: boolean }} SeamOptions */

/** Energy added per fully protected pixel: above any sum of gradients along a seam, so protected pixels go last. */
export const PROTECT_WEIGHT = 1e6;
/** Energy subtracted per pixel marked for removal. */
export const REMOVE_WEIGHT = 1e5;
/** Energy added per skin-tone pixel: about the strongest possible edge, so faces outlast ordinary detail. */
export const SKIN_WEIGHT = 2000;
/** Rank of a pixel whose seam has not been computed yet (it sorts after every computed seam). */
export const UNRANKED = 0x7fffffff;

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const maskOk = (m, n) => !!m && m.length === n;

// ---------------------------------------------------------------------------------------------
// Energy

/** Premultiplied copy of the pixels (4 bytes per pixel): transparent pixels have no colour, so they are flat. */
function premultiplied(img) {
  const s = img.data, n = img.width * img.height * 4, out = new Uint8Array(n);
  for (let i = 0; i < n; i += 4) {
    const a = s[i + 3];
    if (a === 255) {
      out[i] = s[i];
      out[i + 1] = s[i + 1];
      out[i + 2] = s[i + 2];
      out[i + 3] = 255;
    } else if (a > 0) {
      out[i] = (s[i] * a + 127) / 255;
      out[i + 1] = (s[i + 1] * a + 127) / 255;
      out[i + 2] = (s[i + 2] * a + 127) / 255;
      out[i + 3] = a;
    }
  }
  return out;
}

/**
 * Gradient magnitude (|d/dx| + |d/dy| summed over R, G, B, A, central differences, edges replicated) of the
 * first `cw` columns of a premultiplied buffer whose rows are `stride` pixels apart. 0..2040 per pixel.
 */
function gradient(p, stride, cw, h, E) {
  for (let y = 0; y < h; y++) {
    const row = y * stride;
    const up = (y > 0 ? y - 1 : y) * stride, dn = (y < h - 1 ? y + 1 : y) * stride;
    for (let x = 0; x < cw; x++) {
      const l = (row + (x > 0 ? x - 1 : x)) << 2, r = (row + (x < cw - 1 ? x + 1 : x)) << 2;
      const u = (up + x) << 2, d = (dn + x) << 2;
      let e = p[l] - p[r];
      let s = e < 0 ? -e : e;
      e = p[l + 1] - p[r + 1];
      s += e < 0 ? -e : e;
      e = p[l + 2] - p[r + 2];
      s += e < 0 ? -e : e;
      e = p[l + 3] - p[r + 3];
      s += e < 0 ? -e : e;
      e = p[u] - p[d];
      s += e < 0 ? -e : e;
      e = p[u + 1] - p[d + 1];
      s += e < 0 ? -e : e;
      e = p[u + 2] - p[d + 2];
      s += e < 0 ? -e : e;
      e = p[u + 3] - p[d + 3];
      s += e < 0 ? -e : e;
      E[row + x] = s;
    }
  }
}

/** gradient() for the flagged pixels only (the flags are cleared): after a batch of seams only their neighbours change. */
function gradientDirty(p, stride, cw, h, E, dirty, bias) {
  for (let y = 0; y < h; y++) {
    const row = y * stride;
    const up = (y > 0 ? y - 1 : y) * stride, dn = (y < h - 1 ? y + 1 : y) * stride;
    for (let x = 0; x < cw; x++) {
      if (!dirty[row + x]) continue;
      dirty[row + x] = 0;
      const l = (row + (x > 0 ? x - 1 : x)) << 2, r = (row + (x < cw - 1 ? x + 1 : x)) << 2;
      const u = (up + x) << 2, d = (dn + x) << 2;
      const s = Math.abs(p[l] - p[r]) + Math.abs(p[l + 1] - p[r + 1]) + Math.abs(p[l + 2] - p[r + 2]) + Math.abs(p[l + 3] - p[r + 3])
        + Math.abs(p[u] - p[d]) + Math.abs(p[u + 1] - p[d + 1]) + Math.abs(p[u + 2] - p[d + 2]) + Math.abs(p[u + 3] - p[d + 3]);
      E[row + x] = bias ? s + bias[row + x] : s;
    }
  }
}

/**
 * Skin-tone mask (255 = skin): the classic CbCr box (Cb 77..127, Cr 133..173) on pixels that are bright
 * enough and mostly opaque. Coarse on purpose: it only has to bias seams away from faces and hands.
 */
export function skinMask(img) {
  const n = img.width * img.height, d = img.data, out = new Uint8ClampedArray(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    if (d[p + 3] < 128) continue;
    const r = d[p], g = d[p + 1], b = d[p + 2];
    const Y = 0.299 * r + 0.587 * g + 0.114 * b;
    if (Y < 40) continue;
    const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
    const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
    if (cb >= 77 && cb <= 127 && cr >= 133 && cr <= 173) out[i] = 255;
  }
  return out;
}

/** Per-pixel energy offsets from the masks and the skin detector, or null when there are none. */
function biasFor(img, { protect = null, remove = null, skin = false } = {}) {
  const n = img.width * img.height;
  const hasP = maskOk(protect, n), hasR = maskOk(remove, n);
  if (!hasP && !hasR && !skin) return null;
  const bias = new Float32Array(n);
  if (hasP) for (let i = 0; i < n; i++) bias[i] = (protect[i] / 255) * PROTECT_WEIGHT;
  if (skin) {
    const s = skinMask(img);
    for (let i = 0; i < n; i++) if (s[i]) bias[i] += SKIN_WEIGHT;
  }
  // removal wins over protection where both are painted (the user marked the pixel to go)
  if (hasR) for (let i = 0; i < n; i++) if (remove[i]) bias[i] = -(remove[i] / 255) * REMOVE_WEIGHT;
  return bias;
}

/**
 * Energy of every pixel: gradient magnitude plus the protection weights.
 * @param {ImageDataLike} img
 * @param {SeamOptions} [opts]
 * @returns {EnergyMap}
 */
export function energy(img, opts = {}) {
  const w = img.width, h = img.height;
  const data = new Float32Array(w * h);
  if (!w || !h) return { width: w, height: h, data };
  gradient(premultiplied(img), w, w, h, data);
  const bias = biasFor(img, opts);
  if (bias) for (let i = 0; i < data.length; i++) data[i] += bias[i];
  return { width: w, height: h, data };
}

/**
 * The lowest-energy seam by dynamic programming. 'vertical': one x per row (Int32Array of height entries);
 * 'horizontal': one y per column (width entries). Ties go to the straight continuation, then to the left/top.
 * @param {EnergyMap} e
 * @param {'vertical'|'horizontal'} [dir]
 */
export function findSeam(e, dir = 'vertical') {
  const horizontal = dir === 'horizontal';
  // a horizontal seam is a vertical seam of the transposed map
  const w = horizontal ? e.height : e.width, h = horizontal ? e.width : e.height;
  const at = horizontal ? (x, y) => e.data[x * e.width + y] : (x, y) => e.data[y * e.width + x];
  const seam = new Int32Array(h);
  if (!w || !h) return seam;
  const M = new Float64Array(w * h);
  for (let x = 0; x < w; x++) M[x] = at(x, 0);
  for (let y = 1; y < h; y++) {
    const row = y * w, prev = row - w;
    for (let x = 0; x < w; x++) {
      let m = M[prev + x];
      if (x > 0 && M[prev + x - 1] < m) m = M[prev + x - 1];
      if (x < w - 1 && M[prev + x + 1] < m) m = M[prev + x + 1];
      M[row + x] = at(x, y) + m;
    }
  }
  let x = 0;
  for (let i = 1, last = (h - 1) * w; i < w; i++) if (M[last + i] < M[last + x]) x = i;
  for (let y = h - 1; y >= 0; y--) {
    seam[y] = x;
    if (y === 0) break;
    const prev = (y - 1) * w;
    let bx = x, bm = M[prev + x];
    if (x > 0 && M[prev + x - 1] < bm) {
      bx = x - 1;
      bm = M[prev + x - 1];
    }
    if (x < w - 1 && M[prev + x + 1] < bm) bx = x + 1;
    x = bx;
  }
  return seam;
}

// ---------------------------------------------------------------------------------------------
// Seam map

function transposeImage(img) {
  const w = img.width, h = img.height, out = createImage(h, w);
  const s = new Uint32Array(img.data.buffer, img.data.byteOffset, w * h), o = new Uint32Array(out.data.buffer);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) o[x * h + y] = s[y * w + x];
  return out;
}

function transposeMask(mask, w, h) {
  if (!maskOk(mask, w * h)) return null;
  const out = new Uint8ClampedArray(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[x * h + y] = mask[y * w + x];
  return out;
}

/**
 * Starts a seam map of img for one axis. Nothing is computed until step() / ensure() run.
 *
 * `order` ranks every pixel by the seam that removes it (0 = the first seam to go, UNRANKED = not computed
 * yet). Lines are rows for 'vertical' seams (order[y * width + x]) and columns for 'horizontal' seams
 * (order[x * height + y]): every line holds each rank exactly once, so "the first n seams" is the set of
 * pixels with order < n whatever n is.
 *
 * step() runs one pass (gradient, one dynamic-programming sweep, a batch of disjoint seams, compaction) and
 * returns true when every seam is ranked; ensure(n, budgetMs) runs passes until at least n seams are ranked
 * or the budget is spent (always at least one pass, so repeated calls finish) and returns whether n are ranked.
 *
 * @param {ImageDataLike} img
 * @param {'vertical'|'horizontal'} [dir]
 * @param {SeamOptions} [opts]
 */
export function createSeamMap(img, dir = 'vertical', opts = {}) {
  const horizontal = dir === 'horizontal';
  const src = horizontal ? transposeImage(img) : img;
  const w = src.width, h = src.height, n = w * h;
  const o = horizontal ? { protect: transposeMask(opts.protect, img.width, img.height), remove: transposeMask(opts.remove, img.width, img.height), skin: !!opts.skin } : opts;
  const order = new Int32Array(n).fill(UNRANKED);
  const map = { width: img.width, height: img.height, dir: horizontal ? 'horizontal' : 'vertical', lines: h, length: w, order, ranked: 0, passes: 0, done: n === 0, step, ensure };
  if (!n) return map;

  // working copies, compacted to the left of each row as seams go: pixels, their original column and their bias
  const px = premultiplied(src);
  const px32 = new Uint32Array(px.buffer);
  const idx = w <= 0xffff ? new Uint16Array(n) : new Uint32Array(n);
  for (let y = 0; y < h; y++) for (let x = 0, row = y * w; x < w; x++) idx[row + x] = x;
  const bias = biasFor(src, o);
  const E = new Float32Array(n); // gradient + bias, compacted with the pixels and refreshed next to removed seams
  const dirty = new Uint8Array(n);
  const M = new Float64Array(n);
  const used = new Uint16Array(n); // 0 = free, k = pixel of the batch's k-th seam
  const cand = new Int32Array(w);
  // per seam of a batch: current column, cost so far, the batch sorted by cost, and each seam's place among the accepted ones (-1 = dropped)
  const cap = Math.max(1, Math.min(0xfffe, Math.ceil(w / 8)));
  const cur = new Int32Array(cap), byCost = new Int32Array(cap), cost = new Float64Array(cap), rankOf = new Int32Array(cap + 1);
  let cw = w;

  function step() {
    if (cw <= 0) return (map.done = true);
    if (map.passes === 0) {
      gradient(px, w, cw, h, E);
      if (bias) for (let i = 0; i < n; i++) E[i] += bias[i];
    } else gradientDirty(px, w, cw, h, E, dirty, bias);
    // cumulative minimum cost from the top row down
    for (let x = 0; x < cw; x++) M[x] = E[x];
    const last = cw - 1;
    for (let y = 1; y < h; y++) {
      const row = y * w, prev = row - w;
      if (cw === 1) {
        M[row] = E[row] + M[prev];
        continue;
      }
      let l = M[prev], c = M[prev + 1];
      M[row] = E[row] + (l <= c ? l : c);
      for (let x = 1; x < last; x++) {
        const r = M[prev + x + 1];
        let m = c;
        if (l < m) m = l;
        if (r < m) m = r;
        M[row + x] = E[row + x] + m;
        l = c;
        c = r;
      }
      M[row + last] = E[row + last] + (c <= l ? c : l);
    }
    // seam ends on the bottom row, cheapest first
    const bottom = (h - 1) * w;
    for (let x = 0; x < cw; x++) cand[x] = x;
    const ends = cand.subarray(0, cw);
    ends.sort((a, b) => M[bottom + a] - M[bottom + b] || a - b);
    // A batch of seams from this one sweep. The cheapest ends (up to 1/8 of the width: seams found from one
    // sweep get worse the more of them are taken) climb together, one row at a time, which keeps every read
    // inside two rows (that is what makes this fast on large layers). They keep their left-to-right order:
    // the best seam moves first and takes the cheapest of the three pixels above it, then its neighbours
    // follow outwards, each taking the cheapest pixel above that the seam before it left free and that
    // leaves room for the seams still to come. So no seam is ever boxed in and no two share a pixel.
    const maxBatch = Math.max(1, Math.min(cap, Math.ceil(cw / 8)));
    const cut = PROTECT_WEIGHT * 0.5;
    const lowest = M[bottom + ends[0]];
    let K = 1;
    // Ends whose cheapest path already crosses protected pixels wait until nothing else is left. While
    // pixels marked for removal remain, seams go one per pass: there the exact path matters more than speed.
    if (lowest > -REMOVE_WEIGHT * 0.5) while (K < cw && K < maxBatch && !(lowest < cut && M[bottom + ends[K]] >= cut)) K++;
    for (let k = 0; k < K; k++) cur[k] = ends[k];
    cur.subarray(0, K).sort();
    let pivot = 0;
    for (let k = 0; k < K; k++) {
      const p = bottom + cur[k];
      if (cur[k] === ends[0]) pivot = k;
      cost[k] = E[p];
      used[p] = k + 1;
      byCost[k] = k;
    }
    for (let y = h - 1; y > 0; y--) {
      const prev = (y - 1) * w;
      // k = pivot, pivot + 1 .. K - 1, then pivot - 1 .. 0; [a, b] is what seam k may take
      for (let i = 0, k = pivot; i < K; i++, k = i <= K - 1 - pivot ? pivot + i : K - 1 - i) {
        const x = cur[k];
        let a = x - 1, b = x + 1;
        const lo = k > pivot ? cur[k - 1] + 1 : k, hi = k < pivot ? cur[k + 1] - 1 : last - (K - 1 - k);
        if (a < lo) a = lo;
        if (b > hi) b = hi;
        // straight up when it is free and as cheap as the rest, so seams through flat areas stay straight
        let bx = x >= a && x <= b ? x : a, bm = M[prev + bx];
        for (let c = a; c <= b; c++) {
          if (M[prev + c] < bm) {
            bm = M[prev + c];
            bx = c;
          }
        }
        cur[k] = bx;
        cost[k] += E[prev + bx];
        used[prev + bx] = k + 1;
      }
    }
    // Keep the cheapest seam and those that cost about the same; about 1/64 of the width goes per pass
    // even when the rest costs more (so a whole map is a bounded number of passes), but a seam pushed into
    // protected pixels is never taken while unprotected ones exist. The others give their pixels back.
    const picks = byCost.subarray(0, K);
    picks.sort((i, j) => cost[i] - cost[j] || i - j);
    const minBatch = Math.max(1, Math.ceil(cw / 64));
    const least = cost[picks[0]];
    const soft = least + Math.abs(least) * 0.3 + h * 2;
    let count = 0;
    for (let i = 0; i < K; i++) {
      const k = picks[i], c = cost[k];
      rankOf[k + 1] = i === 0 || ((c < cut || least >= cut) && (c <= soft || count < minBatch)) ? count++ : -1;
    }
    // rank the batch and close the gaps; the pixels around each gap (in its row and the rows above and
    // below, where the columns have just shifted against each other) get a fresh gradient next pass
    const base = map.ranked, ncw = cw - count;
    for (let y = 0; y < h; y++) {
      const row = y * w;
      let out = row;
      for (let x = 0, p = row; x < cw; x++, p++) {
        const t = used[p];
        if (t) used[p] = 0;
        if (t && rankOf[t] >= 0) {
          order[row + idx[p]] = base + rankOf[t];
          const o = out - row;
          const x0 = o - 2 < 0 ? 0 : o - 2, x1 = o + 1 >= ncw ? ncw - 1 : o + 1;
          for (let yy = y > 0 ? y - 1 : 0, y1 = y < h - 1 ? y + 1 : y; yy <= y1; yy++) for (let xx = x0, q = yy * w + x0; xx <= x1; xx++, q++) dirty[q] = 1;
        } else {
          if (out !== p) {
            px32[out] = px32[p];
            idx[out] = idx[p];
            E[out] = E[p];
            if (bias) bias[out] = bias[p];
          }
          out++;
        }
      }
    }
    map.ranked += count;
    map.passes++;
    cw -= count;
    return (map.done = cw <= 0);
  }

  function ensure(count = w, budgetMs = Infinity) {
    const need = Math.min(w, Math.max(0, Math.ceil(count)));
    const t0 = now();
    while (map.ranked < need) {
      step();
      if (now() - t0 >= budgetMs) break;
    }
    return map.ranked >= need;
  }

  return map;
}

/** Straight-alpha average of two RGBA pixels (colours weighted by alpha), written at d[o]. */
function average(s, a, b, d, o) {
  const aa = s[a + 3], ab = s[b + 3], sum = aa + ab;
  if (!sum) {
    d[o] = d[o + 1] = d[o + 2] = d[o + 3] = 0;
    return;
  }
  d[o] = (s[a] * aa + s[b] * ab) / sum + 0.5;
  d[o + 1] = (s[a + 1] * aa + s[b + 1] * ab) / sum + 0.5;
  d[o + 2] = (s[a + 2] * aa + s[b + 2] * ab) / sum + 0.5;
  d[o + 3] = (sum + 1) >> 1;
}

/** Target size along the map's axis that a lookup can reach: 1 .. twice the length (every seam duplicated once). */
const reachable = (map, target) => Math.max(Math.min(1, map.length), Math.min(map.length * 2, Math.round(target)));

/**
 * Scales img along the map's axis to `target` pixels by lookup: below the original size the first seams are
 * dropped, above it they are duplicated (each new pixel is the average of the seam pixel and its neighbour,
 * so the insertion does not show as a doubled line). Because the seams of a map are distinct, widening
 * spreads over the image instead of repeating one seam. Up to twice the size can be reached (then every
 * pixel has been duplicated once); the caller scales plainly beyond that. The map is extended when needed.
 * img must have the size the map was built for (it may be another image of that size).
 */
export function applySeamMap(img, map, target) {
  const W = img.width, H = img.height;
  if (W !== map.width || H !== map.height) throw new Error('The seam map was built for another image size');
  const len = map.length, lines = map.lines;
  const t = reachable(map, target);
  if (t === len || !len || !lines) return { width: W, height: H, data: new Uint8ClampedArray(img.data) };
  const vertical = map.dir === 'vertical';
  const n = Math.abs(t - len);
  map.ensure(n);
  const out = vertical ? createImage(t, H) : createImage(W, t);
  const order = map.order;
  // line L, position i: source pixel sBase(L) + i * sStep, destination dBase(L) + o * dStep
  const sStep = vertical ? 1 : W, dStep = vertical ? 1 : W;
  if (t < len) {
    const s32 = new Uint32Array(img.data.buffer, img.data.byteOffset, W * H), d32 = new Uint32Array(out.data.buffer);
    for (let L = 0; L < lines; L++) {
      const sBase = vertical ? L * W : L, dBase = vertical ? L * t : L, ob = L * len;
      let o = 0;
      for (let i = 0; i < len; i++) if (order[ob + i] >= n) d32[dBase + o++ * dStep] = s32[sBase + i * sStep];
    }
    return out;
  }
  const s = img.data, d = out.data;
  for (let L = 0; L < lines; L++) {
    const sBase = vertical ? L * W : L, dBase = vertical ? L * t : L, ob = L * len;
    let o = 0;
    for (let i = 0; i < len; i++) {
      const sp = (sBase + i * sStep) << 2;
      let dp = (dBase + o++ * dStep) << 2;
      d[dp] = s[sp];
      d[dp + 1] = s[sp + 1];
      d[dp + 2] = s[sp + 2];
      d[dp + 3] = s[sp + 3];
      if (order[ob + i] < n) {
        dp = (dBase + o++ * dStep) << 2;
        average(s, sp, i < len - 1 ? sp + (sStep << 2) : sp, d, dp);
      }
    }
  }
  return out;
}

/**
 * Carries a width*height mask (protection, a selection) through the same seams as applySeamMap, so it keeps
 * lining up with the scaled pixels. Returns the mask at the new size (Uint8ClampedArray).
 */
export function applySeamMapToMask(mask, map, target) {
  const W = map.width, H = map.height;
  if (mask.length !== W * H) throw new Error('The mask does not match the seam map');
  const len = map.length, lines = map.lines;
  const t = reachable(map, target);
  if (t === len || !len || !lines) return new Uint8ClampedArray(mask);
  const vertical = map.dir === 'vertical';
  const n = Math.abs(t - len);
  map.ensure(n);
  const out = new Uint8ClampedArray(vertical ? t * H : W * t);
  const order = map.order, step = vertical ? 1 : W;
  for (let L = 0; L < lines; L++) {
    const sBase = vertical ? L * W : L, dBase = vertical ? L * t : L, ob = L * len;
    let o = 0;
    for (let i = 0; i < len; i++) {
      const r = order[ob + i], v = mask[sBase + i * step];
      if (t < len) {
        if (r >= n) out[dBase + o++ * step] = v;
      } else {
        out[dBase + o++ * step] = v;
        if (r < n) out[dBase + o++ * step] = (v + mask[sBase + (i < len - 1 ? i + 1 : i) * step] + 1) >> 1;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// One-shot operations

const axisLength = (img, dir) => (dir === 'horizontal' ? img.height : img.width);

/**
 * Removes `count` seams ('vertical': the image gets narrower, 'horizontal': shorter). At least one pixel
 * stays along the axis. opts: { protect, remove, skin } as for energy().
 */
export function removeSeams(img, count, dir = 'vertical', opts = {}) {
  const len = axisLength(img, dir);
  const n = Math.max(0, Math.min(len - 1, Math.round(count) || 0));
  if (n <= 0) return { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) };
  return applySeamMap(img, createSeamMap(img, dir, opts), len - n);
}

/** Resizes a mask the way the scaled image was resized, when a caller needs the masks to follow. */
function carryMasks(opts, map, target) {
  const n = map.width * map.height, out = { skin: !!opts.skin };
  if (maskOk(opts.protect, n)) out.protect = applySeamMapToMask(opts.protect, map, target);
  if (maskOk(opts.remove, n)) out.remove = applySeamMapToMask(opts.remove, map, target);
  return out;
}

/**
 * Inserts `count` seams: the lowest-energy seams are duplicated, each new pixel averaged with its neighbour.
 * The seams are chosen on the unmodified image (a map), so they spread instead of piling up on the single
 * cheapest one. At most half the size is added per round; larger counts take more rounds on the grown image.
 */
export function insertSeams(img, count, dir = 'vertical', opts = {}) {
  let left = Math.max(0, Math.round(count) || 0);
  let cur = img, o = opts, copied = false;
  while (left > 0) {
    const len = axisLength(cur, dir);
    if (!len || !cur.width || !cur.height) break;
    const n = Math.min(left, Math.max(1, len >> 1));
    const map = createSeamMap(cur, dir, o);
    const next = applySeamMap(cur, map, len + n);
    left -= n;
    if (left > 0) o = carryMasks(o, map, len + n);
    cur = next;
    copied = true;
  }
  return copied ? cur : { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) };
}

/** A mask resized like an image (bilinear), through an RGBA carrier. */
function resizeMask(mask, w, h, newW, newH) {
  if (w === newW && h === newH) return new Uint8ClampedArray(mask);
  const carrier = createImage(w, h);
  for (let i = 0, p = 0; i < mask.length; i++, p += 4) {
    carrier.data[p] = carrier.data[p + 1] = carrier.data[p + 2] = mask[i];
    carrier.data[p + 3] = 255;
  }
  const r = resize(carrier, newW, newH, { method: 'bilinear' });
  const out = new Uint8ClampedArray(newW * newH);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) out[i] = r.data[p];
  return out;
}

/**
 * A reusable scaler for one image: the seam maps are cached, so asking for another size is a lookup.
 * Width is carved first, then height on the result (the second map depends on the first target and is
 * rebuilt when the width changes). `amount` (0..100) is how much of the size change is done by seams; the
 * rest is plain bicubic scaling (0 = an ordinary resize, 100 = seams only). Sizes beyond twice the original
 * are reached by plain scaling too.
 *
 * - prepare(width, height, amount, budgetMs): does at most about budgetMs of map building for that target and
 *   returns true when scale() would have nothing left to compute (call it per frame until it is true)
 * - scale(width, height, amount): the scaled image (finishes any missing map work first)
 * - scaleMask(mask, width, height, amount): a width*height mask carried through the same seams and scaling
 *
 * @param {ImageDataLike} img
 * @param {SeamOptions} [opts]
 */
export function createContentAwareScaler(img, opts = {}) {
  const W = img.width, H = img.height, N = W * H;
  const base = { protect: maskOk(opts.protect, N) ? opts.protect : null, remove: maskOk(opts.remove, N) ? opts.remove : null, skin: !!opts.skin };
  let mapV = null;
  /** The stage after the width pass: { seamW, image, opts, mapH }. */
  let stage = null;

  const plan = (width, height, amount) => {
    const k = Math.max(0, Math.min(100, Number.isFinite(amount) ? amount : 100)) / 100;
    const tw = Math.max(1, Math.round(width)), th = Math.max(1, Math.round(height));
    const seamW = Math.max(1, Math.min(W * 2, Math.round(W + (tw - W) * k)));
    const seamH = Math.max(1, Math.min(H * 2, Math.round(H + (th - H) * k)));
    return { tw, th, seamW, seamH };
  };

  function stageFor(seamW) {
    if (stage && stage.seamW === seamW) return stage;
    if (seamW === W) stage = { seamW, image: img, opts: base, mapH: null };
    else stage = { seamW, image: applySeamMap(img, mapV, seamW), opts: carryMasks(base, mapV, seamW), mapH: null };
    return stage;
  }

  function prepare(width, height, amount = 100, budgetMs = Infinity) {
    if (!N) return true;
    const { seamW, seamH } = plan(width, height, amount);
    const t0 = now();
    if (seamW !== W) {
      mapV ??= createSeamMap(img, 'vertical', base);
      if (!mapV.ensure(Math.abs(seamW - W), budgetMs)) return false;
    }
    if (seamH === H) return true;
    const st = stageFor(seamW);
    st.mapH ??= createSeamMap(st.image, 'horizontal', st.opts);
    const need = Math.abs(seamH - H);
    if (st.mapH.ranked >= need) return true;
    return st.mapH.ensure(need, Math.max(0, budgetMs - (now() - t0))); // at least one pass, so every call gets somewhere
  }

  function scale(width, height, amount = 100) {
    const { tw, th, seamW, seamH } = plan(width, height, amount);
    if (!N) return createImage(tw, th);
    prepare(width, height, amount, Infinity);
    const st = stageFor(seamW);
    let out = seamH === H ? st.image : applySeamMap(st.image, st.mapH, seamH);
    if (out.width !== tw || out.height !== th) out = resize(out, tw, th, { method: 'bicubic' });
    else if (out === st.image) out = { width: out.width, height: out.height, data: new Uint8ClampedArray(out.data) }; // never hand out the cached stage
    return out;
  }

  function scaleMask(mask, width, height, amount = 100) {
    if (mask.length !== N) throw new Error('The mask does not match the image');
    const { tw, th, seamW, seamH } = plan(width, height, amount);
    if (!N) return new Uint8ClampedArray(tw * th);
    prepare(width, height, amount, Infinity);
    const st = stageFor(seamW);
    let m = seamW === W ? mask : applySeamMapToMask(mask, mapV, seamW);
    if (seamH !== H) m = applySeamMapToMask(m, st.mapH, seamH);
    return resizeMask(m, seamW, seamH, tw, th);
  }

  return { width: W, height: H, prepare, scale, scaleMask };
}

/**
 * Content-aware scale to width x height.
 * @param {ImageDataLike} img
 * @param {{ width?: number, height?: number, amount?: number, protect?: Uint8ClampedArray | null, remove?: Uint8ClampedArray | null, skin?: boolean }} [opts]
 *   amount 0..100 blends between plain scaling (0) and seam carving (100, default)
 * @returns {ImageDataLike}
 */
export function contentAwareScale(img, { width = img.width, height = img.height, amount = 100, protect = null, remove = null, skin = false } = {}) {
  return createContentAwareScaler(img, { protect, remove, skin }).scale(width, height, amount);
}
