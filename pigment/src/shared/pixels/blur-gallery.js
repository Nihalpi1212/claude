// Blur Gallery kinds (builder "blur-gallery"): Field Blur, Iris Blur, Tilt-Shift, Path Blur and
// Spin Blur. Each kind is a plain filter whose params hold the pins the on-canvas session edits
// (lib/blur-gallery-ui.js registers a custom opener through app.filterEditor.register), so smart
// filters, actions and the assistant can re-run them from params alone. Conventions:
//
// - Coordinates in params are fractions of the image the filter is applied to (0..1; x and rx of
//   its width, y and ry of its height), so the same pins apply after a resize. `blur` values and
//   path `endSpeeds` are px of that image: a caller that previews on a reduced copy scales them
//   with scaleBlurParams(). Pixel centres sit at (i + 0.5, j + 0.5), a pin at (x * width, y * height).
// - The conventions at the top of filters.js hold: rect only limits writes (the result inside rect
//   is what a whole-image run produces), straight alpha in and out with alpha-weighted averaging,
//   nothing is read outside the image (edges replicate), grain is deterministic per (seed, x, y).
// - This module does not import filters.js (the tables form a cycle), so it can be loaded on its own.
//
// How the three "lens" kinds (field, iris, tilt-shift) stay fast: they only differ in the per-pixel
// blur radius (sigma). The image is blurred once at a ladder of radii 0.5, 0.71, 1, 1.41, 2, 2.83, 4 ...
// (a blur pyramid) and every pixel mixes the two levels around its own radius, matching the
// variance. Levels of 2.83 px and more are computed on a binomial mip of the image (stride = the
// largest power of two <= sigma / sqrt 2, so a 64 px blur runs on 1/32 of the pixels per axis) and
// brought back with a quadratic B-spline whose own blur is subtracted from the level's Gaussian;
// the five small levels are convolved at full size, but only inside the 128 px tiles that have
// such small radii. A uniform radius (one field pin) is a single level at exactly that sigma.
// A 4000x3000 layer takes a few seconds.
//
// Spin and path blur average along a flow (rotation about a pin, translation along a path). They
// run two passes of n taps each: pass 1 averages n taps over 1/n of the kernel, pass 2 averages n
// of those results spread over the whole kernel, which equals n * n taps for 2n (n <= 16).

import { num, clampNum, round8, smoothstep, DEG, region, isEmptyRegion, defineFilter } from './filter-def.js';

/** @typedef {import('./core.js').ImageDataLike} ImageDataLike */
/** @typedef {import('./core.js').Rect} Rect */

const TILE = 128;
/** Radii (and kernel lengths) below this leave a pixel untouched. */
const EPS = 0.02;
const SQRT2 = Math.SQRT2;
/** Highlights inside the light range are multiplied by up to 1 + BOKEH_GAIN before blurring (they clip back to white as discs). */
const BOKEH_GAIN = 5;
/** Full-strength grain is this many levels (uniform: +-, gaussian: 2 sigma), like Add Noise at 50 %. */
const GRAIN_LEVELS = 64;
const MAX_BLUR = 2000;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const fullRegion = (img, r) => r.x === 0 && r.y === 0 && r.width === img.width && r.height === img.height;

/**
 * Runs fn on the whole image and keeps only rect: for the kinds whose passes read far from the
 * pixel they write (flows, chained pins), which is the simple way to make a partial repaint equal
 * the whole-image result.
 */
function wholeThenRect(img, r, fn) {
  if (fullRegion(img, r)) return fn(img);
  const work = { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) };
  fn(work);
  const row = r.width * 4, W = img.width;
  for (let y = r.y; y < r.y + r.height; y++) {
    const o = (y * W + r.x) * 4;
    img.data.set(work.data.subarray(o, o + row), o);
  }
  return img;
}

// ---------------------------------------------------------------------------------------------
// Bokeh: highlight boost applied to what the blur reads

/** Per-luminance gain and saturation tables of the bokeh effect, or null when it is off. */
function bokehLuts(b) {
  const amount = clampNum(num(b?.lightBokeh, 0), 0, 100) / 100;
  if (!(amount > 0)) return null;
  const color = clampNum(num(b?.bokehColor, 0), 0, 100) / 100;
  let lo = clampNum(num(b?.lightRange?.[0], 191), 0, 255), hi = clampNum(num(b?.lightRange?.[1], 255), 0, 255);
  if (hi < lo) [lo, hi] = [hi, lo];
  const gain = new Float32Array(256), sat = new Float32Array(256);
  for (let L = 0; L < 256; L++) {
    // soft edges so the boost does not posterise at the range limits
    let w = lo <= 0 ? 1 : smoothstep(lo - 8, lo + 8, L);
    if (hi < 255) w *= 1 - smoothstep(hi - 8, hi + 8, L);
    gain[L] = 1 + amount * BOKEH_GAIN * w;
    sat[L] = 1 + color * 2 * w;
  }
  return { gain, sat };
}

/**
 * Converts n pixels of row y from column x0 (both clamped: edge replication) into premultiplied
 * floats on the 0..255 scale (alpha included), boosted by the bokeh tables when given.
 */
function loadRow(src, W, H, y, x0, n, dst, o, lut) {
  const base = (y < 0 ? 0 : y >= H ? H - 1 : y) * W;
  for (let k = 0; k < n; k++, o += 4) {
    let x = x0 + k;
    if (x < 0) x = 0;
    else if (x >= W) x = W - 1;
    const i = (base + x) * 4;
    const a = src[i + 3];
    if (a === 0) {
      dst[o] = dst[o + 1] = dst[o + 2] = dst[o + 3] = 0;
      continue;
    }
    let r = src[i], g = src[i + 1], b = src[i + 2];
    if (lut) {
      const L = (r * 77 + g * 150 + b * 29) >> 8;
      const gn = lut.gain[L];
      if (gn !== 1) {
        const s = lut.sat[L];
        if (s !== 1) {
          r = L + (r - L) * s;
          g = L + (g - L) * s;
          b = L + (b - L) * s;
          if (r < 0) r = 0;
          if (g < 0) g = 0;
          if (b < 0) b = 0;
        }
        r *= gn;
        g *= gn;
        b *= gn;
      }
    }
    if (a !== 255) {
      const f = a / 255;
      r *= f;
      g *= f;
      b *= f;
    }
    dst[o] = r;
    dst[o + 1] = g;
    dst[o + 2] = b;
    dst[o + 3] = a;
  }
}

// ---------------------------------------------------------------------------------------------
// Separable passes on premultiplied float RGBA buffers (edges replicated)

/** Normalised sampled Gaussian with half width ceil(3 sigma). */
function gaussKernel(sigma) {
  const K = Math.max(1, Math.ceil(3 * sigma));
  const k = new Float32Array(2 * K + 1);
  const s2 = 2 * sigma * sigma;
  let sum = 0;
  for (let j = -K; j <= K; j++) sum += k[j + K] = Math.exp(-(j * j) / s2);
  for (let j = 0; j < k.length; j++) k[j] /= sum;
  return { k, K };
}

/**
 * Reduced grids carry MIP_PAD extra cells on every side. A cell that far outside the image holds
 * exactly the replicated edge pixel, so clamping at the padded border equals replicating the edge
 * of the full-size image (clamping at the unpadded border would replicate an average instead).
 */
const MIP_PAD = 12;

/**
 * One row halved with the binomial [1 3 3 1] / 8 (output i sits between input 2i and 2i + 1).
 * f holds w + 2 * pin pixels (pin = padding of the input), dst w2 + 2 * MIP_PAD.
 */
function halveRow(f, w, pin, dst, w2) {
  const lo = -pin, hi = w + pin - 1;
  for (let i = -MIP_PAD, o = 0; i < w2 + MIP_PAD; i++, o += 4) {
    let a = 2 * i - 1, b = 2 * i, c = 2 * i + 1, d = 2 * i + 2;
    a = ((a < lo ? lo : a > hi ? hi : a) + pin) * 4;
    b = ((b < lo ? lo : b > hi ? hi : b) + pin) * 4;
    c = ((c < lo ? lo : c > hi ? hi : c) + pin) * 4;
    d = ((d < lo ? lo : d > hi ? hi : d) + pin) * 4;
    dst[o] = (f[a] + 3 * (f[b] + f[c]) + f[d]) * 0.125;
    dst[o + 1] = (f[a + 1] + 3 * (f[b + 1] + f[c + 1]) + f[d + 1]) * 0.125;
    dst[o + 2] = (f[a + 2] + 3 * (f[b + 2] + f[c + 2]) + f[d + 2]) * 0.125;
    dst[o + 3] = (f[a + 3] + 3 * (f[b + 3] + f[c + 3]) + f[d + 3]) * 0.125;
  }
}

/**
 * Half-size binomial reduction of a w x h image given row by row: getRow(y, dst) fills the
 * (w + 2 * pin) * 4 floats of row y, for y in -pin .. h + pin - 1. Only four half-width rows are
 * kept at a time, so the full-size float image never exists. Returns a grid of
 * (w2 + 2 * MIP_PAD) x (h2 + 2 * MIP_PAD) cells whose cell (0, 0) sits at data offset pad.
 */
function mipDown(getRow, w, h, pin) {
  const w2 = (w + 1) >> 1, h2 = (h + 1) >> 1, ow = w2 + 2 * MIP_PAD, oh = h2 + 2 * MIP_PAD;
  const data = new Float32Array(ow * oh * 4);
  const fine = new Float32Array((w + 2 * pin) * 4);
  const ring = [0, 1, 2, 3].map(() => new Float32Array(ow * 4));
  const lo = -pin, hi = h + pin - 1;
  let have = lo - 1;
  const row = (y) => {
    const yy = y < lo ? lo : y > hi ? hi : y;
    while (have < yy) {
      have++;
      getRow(have, fine);
      halveRow(fine, w, pin, ring[(have + pin) & 3], w2);
    }
    return ring[(yy + pin) & 3];
  };
  const n = ow * 4;
  for (let i = -MIP_PAD, o = 0; i < h2 + MIP_PAD; i++, o += n) {
    // the last row first, so the three before it are still in the ring
    const r3 = row(2 * i + 2), r0 = row(2 * i - 1), r1 = row(2 * i), r2 = row(2 * i + 1);
    for (let x = 0; x < n; x++) data[o + x] = (r0[x] + 3 * (r1[x] + r2[x]) + r3[x]) * 0.125;
  }
  return { w: w2, h: h2, ow, oh, data };
}

// ---------------------------------------------------------------------------------------------
// The blur pyramid

/** Stride of the grid a level of this sigma is computed on (1 = full size). */
function strideFor(sigma) {
  let s = 1;
  while (s * 2 <= sigma / SQRT2 + 1e-9) s *= 2;
  return s;
}

/** Reduced levels are blurred in blocks of this many cells, and only the blocks a tile reads. */
const BLOCK = 64;

/**
 * Gaussian of one block of a reduced level, from the level's mip (H then V, the grid's border
 * cells replicated). Every cell is computed the same way whichever block it falls in.
 */
function blockGauss(lv, bx, by, tmp) {
  const { k, K } = lv.kern;
  const ow = lv.ow, oh = lv.oh, src = lv.mip, out = lv.data, taps = 2 * K + 1;
  const X0 = bx * BLOCK, X1 = Math.min(ow, X0 + BLOCK), Y0 = by * BLOCK, Y1 = Math.min(oh, Y0 + BLOCK);
  const bw = X1 - X0, rows = Y1 - Y0 + 2 * K, inside = X0 - K >= 0 && X1 + K <= ow;
  for (let y = 0; y < rows; y++) {
    let yy = Y0 - K + y;
    if (yy < 0) yy = 0;
    else if (yy >= oh) yy = oh - 1;
    const row = yy * ow;
    let o = y * bw * 4;
    for (let x = X0; x < X1; x++, o += 4) {
      let r = 0, g = 0, b = 0, a = 0;
      if (inside) {
        let s = (row + x - K) * 4;
        for (let j = 0; j < taps; j++, s += 4) {
          const kv = k[j];
          r += kv * src[s];
          g += kv * src[s + 1];
          b += kv * src[s + 2];
          a += kv * src[s + 3];
        }
      } else {
        for (let j = 0; j < taps; j++) {
          let xx = x + j - K;
          if (xx < 0) xx = 0;
          else if (xx >= ow) xx = ow - 1;
          const s = (row + xx) * 4, kv = k[j];
          r += kv * src[s];
          g += kv * src[s + 1];
          b += kv * src[s + 2];
          a += kv * src[s + 3];
        }
      }
      tmp[o] = r;
      tmp[o + 1] = g;
      tmp[o + 2] = b;
      tmp[o + 3] = a;
    }
  }
  const n = bw * 4;
  for (let y = Y0; y < Y1; y++) {
    const o = (y * ow + X0) * 4;
    for (let i = 0; i < n; i++) out[o + i] = 0;
    for (let j = 0; j < taps; j++) {
      const s = (y - Y0 + j) * n, kv = k[j];
      for (let i = 0; i < n; i++) out[o + i] += kv * tmp[s + i];
    }
  }
}

/**
 * Lazily built pyramid over the (bokeh-boosted, premultiplied) source: mip(j) is the image
 * reduced by 2^j, level(sigma) the Gaussian of that sigma on its stride grid, filled in block by
 * block as tiles ask for cells (ensure). A mip of stride S carries a blur of variance
 * (S^2 - 1) / 4 px^2 and the B-spline that upsamples a level adds S^2 / 4, so the level's own
 * Gaussian gets what is left of sigma^2.
 */
function makePyramid(src, W, H, lut) {
  const mips = [];
  const mip = (j) => {
    while (mips.length < j) {
      const prev = mips[mips.length - 1];
      mips.push(prev
        ? mipDown((y, dst) => dst.set(prev.data.subarray((y + MIP_PAD) * prev.ow * 4, (y + MIP_PAD + 1) * prev.ow * 4)), prev.w, prev.h, MIP_PAD)
        : mipDown((y, dst) => loadRow(src, W, H, y, 0, W, dst, 0, lut), W, H, 0));
    }
    return mips[j - 1];
  };
  const levels = new Map();
  let tmp = null;
  return {
    level(sigma, S) {
      let lv = levels.get(sigma);
      if (!lv) {
        const m = mip(Math.round(Math.log2(S)));
        const sr = sigma / S;
        const kern = gaussKernel(Math.sqrt(Math.max(0.25, sr * sr - (S * S - 1) / (4 * S * S) - 0.25)));
        const nbx = Math.ceil(m.ow / BLOCK);
        lv = { stride: S, w: m.w, h: m.h, ow: m.ow, oh: m.oh, mip: m.data, kern, data: new Float32Array(m.data.length), nbx, done: new Uint8Array(nbx * Math.ceil(m.oh / BLOCK)) };
        levels.set(sigma, lv);
      }
      return lv;
    },
    /** Makes the cells [x0, x1] x [y0, y1] (data indices, inclusive) of a level available. */
    ensure(lv, x0, y0, x1, y1) {
      for (let by = Math.floor(y0 / BLOCK); by <= Math.floor(y1 / BLOCK); by++) {
        for (let bx = Math.floor(x0 / BLOCK); bx <= Math.floor(x1 / BLOCK); bx++) {
          if (lv.done[by * lv.nbx + bx]) continue;
          tmp ??= new Float32Array((BLOCK + 2 * 16) * BLOCK * 4);
          blockGauss(lv, bx, by, tmp);
          lv.done[by * lv.nbx + bx] = 1;
        }
      }
    },
  };
}

/** Quadratic B-spline upsampling of a reduced level into the tile (tx, ty, tw, th) of the full image. */
function upsampleTile(pyramid, lv, tx, ty, tw, th, out, scratch) {
  const S = lv.stride, ow = lv.ow, d = lv.data, inv = 1 / S;
  // valid cells: -MIP_PAD .. w + MIP_PAD - 1 (and the same for rows); P shifts a cell index to its data offset
  const P = MIP_PAD, xmax = lv.w + P - 1, ymax = lv.h + P - 1;
  const cell = (i, max) => (i < -P ? -P : i > max ? max : i) + P;
  const rowOf = (i) => cell(i, ymax) * ow;
  const c0 = Math.round((tx + 0.5) * inv - 0.5) - 1;
  const nc = Math.round((tx + tw - 0.5) * inv - 0.5) + 1 - c0 + 1;
  const tmp = scratch.row, kx = scratch.kx, wa = scratch.wa, wb = scratch.wb, wc = scratch.wc;
  pyramid.ensure(lv, cell(c0, xmax), cell(Math.round((ty + 0.5) * inv - 0.5) - 1, ymax), cell(c0 + nc - 1, xmax), cell(Math.round((ty + th - 0.5) * inv - 0.5) + 1, ymax));
  for (let x = 0; x < tw; x++) {
    const u = (tx + x + 0.5) * inv - 0.5, i = Math.round(u), f = u - i;
    kx[x] = (i - 1 - c0) * 4;
    wa[x] = 0.5 * (0.5 - f) * (0.5 - f);
    wb[x] = 0.75 - f * f;
    wc[x] = 0.5 * (0.5 + f) * (0.5 + f);
  }
  for (let y = 0; y < th; y++) {
    const v = (ty + y + 0.5) * inv - 0.5, i = Math.round(v), f = v - i;
    const va = 0.5 * (0.5 - f) * (0.5 - f), vb = 0.75 - f * f, vc = 0.5 * (0.5 + f) * (0.5 + f);
    const ra = rowOf(i - 1), rb = rowOf(i), rc = rowOf(i + 1);
    for (let c = 0, o = 0; c < nc; c++, o += 4) {
      let cc = c0 + c;
      if (cc < -P) cc = -P;
      else if (cc > xmax) cc = xmax;
      cc += P;
      const a = (ra + cc) * 4, b = (rb + cc) * 4, e = (rc + cc) * 4;
      tmp[o] = va * d[a] + vb * d[b] + vc * d[e];
      tmp[o + 1] = va * d[a + 1] + vb * d[b + 1] + vc * d[e + 1];
      tmp[o + 2] = va * d[a + 2] + vb * d[b + 2] + vc * d[e + 2];
      tmp[o + 3] = va * d[a + 3] + vb * d[b + 3] + vc * d[e + 3];
    }
    let o = y * tw * 4;
    for (let x = 0; x < tw; x++, o += 4) {
      const k = kx[x], a = wa[x], b = wb[x], c = wc[x];
      out[o] = a * tmp[k] + b * tmp[k + 4] + c * tmp[k + 8];
      out[o + 1] = a * tmp[k + 1] + b * tmp[k + 5] + c * tmp[k + 9];
      out[o + 2] = a * tmp[k + 2] + b * tmp[k + 6] + c * tmp[k + 10];
      out[o + 3] = a * tmp[k + 3] + b * tmp[k + 7] + c * tmp[k + 11];
    }
  }
}

/**
 * Gaussian of the tile from its window (the tile plus M px on every side, already loaded as
 * floats): the full-size levels, computed only where a tile asks for them.
 */
function windowGauss(win, ww, M, tw, th, kern, out, tmp) {
  const { k, K } = kern;
  const taps = 2 * K + 1, rows = th + 2 * K;
  // horizontal: rows M - K .. M + th + K of the window, columns of the tile
  for (let y = 0; y < rows; y++) {
    let o = y * tw * 4;
    const base = ((M - K + y) * ww + (M - K)) * 4;
    for (let x = 0; x < tw; x++, o += 4) {
      let r = 0, g = 0, b = 0, a = 0, s = base + x * 4;
      for (let j = 0; j < taps; j++, s += 4) {
        const kv = k[j];
        r += kv * win[s];
        g += kv * win[s + 1];
        b += kv * win[s + 2];
        a += kv * win[s + 3];
      }
      tmp[o] = r;
      tmp[o + 1] = g;
      tmp[o + 2] = b;
      tmp[o + 3] = a;
    }
  }
  const n = tw * 4;
  out.fill(0, 0, th * n);
  for (let y = 0; y < th; y++) {
    const o = y * n;
    for (let j = 0; j < taps; j++) {
      const s = (y + j) * n, kv = k[j];
      for (let i = 0; i < n; i++) out[o + i] += kv * tmp[s + i];
    }
  }
}

/**
 * Variable-radius Gaussian blur of img inside r. `radius` holds one sigma per pixel of `mr` (a
 * rect that contains r); `uniform` (a number) says every pixel has that radius, which then runs
 * as one exact level. Pixels with a radius below EPS are not touched.
 */
function variableBlur(img, r, radius, mr, { uniform = null, lut = null } = {}) {
  const W = img.width, H = img.height, d = img.data;
  let rmax = 0;
  if (uniform !== null) rmax = uniform;
  else {
    for (let y = 0; y < r.height; y++) {
      let p = (r.y - mr.y + y) * mr.width + (r.x - mr.x);
      for (let x = 0; x < r.width; x++, p++) if (radius[p] > rmax) rmax = radius[p];
    }
  }
  if (!(rmax > EPS)) return;
  // the ladder: 0, then 0.5, 0.71, 1, 1.41, 2 ... up to the first level that covers rmax (or [0, sigma] when uniform)
  const sig = [0];
  if (uniform !== null) sig.push(uniform);
  else for (let i = 1; sig[sig.length - 1] < rmax; i++) sig.push(i % 2 ? 2 ** ((i - 3) / 2) : SQRT2 * 2 ** ((i - 4) / 2));
  const top = sig.length - 1, sigTop = sig[top], ladder = uniform === null;
  const stride = sig.map((s) => (s > 0 ? strideFor(s) : 1));
  const kern = sig.map((s, i) => (i > 0 && stride[i] === 1 ? gaussKernel(s) : null));
  let M = 0;
  for (const k of kern) if (k && k.K > M) M = k.K;
  const src = new Uint8ClampedArray(d); // the tiles read around themselves while the result is written in place
  const pyramid = makePyramid(src, W, H, lut);
  const bufs = sig.map(() => null);
  const ww = TILE + 2 * M;
  const win = M > 0 ? new Float32Array(ww * ww * 4) : null;
  const tmp = M > 0 ? new Float32Array(TILE * ww * 4) : null;
  const scratch = { row: new Float32Array((TILE + 4) * 4), kx: new Int32Array(TILE), wa: new Float32Array(TILE), wb: new Float32Array(TILE), wc: new Float32Array(TILE) };
  /** Index of the ladder level at or below a radius (sig[i] = 2^((i - 3) / 2) for i >= 1). */
  const levelOf = (rad) => (rad >= sigTop ? top : rad < sig[1] ? 0 : Math.min(top - 1, 3 + Math.floor(2 * Math.log2(rad) + 1e-9)));
  const x1 = r.x + r.width, y1 = r.y + r.height;
  for (let ty = Math.floor(r.y / TILE) * TILE; ty < y1; ty += TILE) {
    const ya = Math.max(ty, r.y), yb = Math.min(ty + TILE, y1), th = yb - ya;
    for (let tx = Math.floor(r.x / TILE) * TILE; tx < x1; tx += TILE) {
      const xa = Math.max(tx, r.x), xb = Math.min(tx + TILE, x1), tw = xb - xa;
      let lo = top, hi = 0;
      if (ladder) {
        let tmin = Infinity, tmax = 0;
        for (let y = ya; y < yb; y++) {
          let p = (y - mr.y) * mr.width + (xa - mr.x);
          for (let x = 0; x < tw; x++, p++) {
            const v = radius[p];
            if (v > EPS) {
              if (v < tmin) tmin = v;
              if (v > tmax) tmax = v;
            }
          }
        }
        if (!(tmax > EPS)) continue;
        lo = levelOf(tmin);
        hi = Math.min(top, levelOf(tmax) + 1);
      } else lo = hi = top;
      // the tile's copy of every level its radii fall between
      let loaded = false;
      for (let i = Math.max(1, lo); i <= hi; i++) {
        const buf = (bufs[i] ??= new Float32Array(TILE * TILE * 4));
        if (stride[i] === 1) {
          if (!loaded) {
            const n = tw + 2 * M;
            for (let y = 0; y < th + 2 * M; y++) loadRow(src, W, H, ya - M + y, xa - M, n, win, y * ww * 4, lut);
            loaded = true;
          }
          windowGauss(win, ww, M, tw, th, kern[i], buf, tmp);
        } else upsampleTile(pyramid, pyramid.level(sig[i], stride[i]), xa, ya, tw, th, buf, scratch);
      }
      for (let y = ya; y < yb; y++) {
        let p = (y - mr.y) * mr.width + (xa - mr.x);
        let i = (y * W + xa) * 4, o = (y - ya) * tw * 4;
        for (let x = 0; x < tw; x++, p++, i += 4, o += 4) {
          const rad = ladder ? radius[p] : uniform;
          if (!(rad > EPS)) continue;
          let cr, cg, cb, ca;
          if (rad >= sigTop) {
            const A = bufs[top];
            cr = A[o];
            cg = A[o + 1];
            cb = A[o + 2];
            ca = A[o + 3];
          } else {
            let lv = lo;
            while (rad >= sig[lv + 1]) lv++;
            const s0 = sig[lv], s1 = sig[lv + 1];
            const t = clamp01((rad * rad - s0 * s0) / (s1 * s1 - s0 * s0));
            const B = bufs[lv + 1];
            if (lv === 0) {
              // level 0 is the pixel itself (not boosted: a sharp pixel stays what it was)
              const a = src[i + 3], f = a / 255;
              cr = src[i] * f;
              cg = src[i + 1] * f;
              cb = src[i + 2] * f;
              ca = a;
            } else {
              const A = bufs[lv];
              cr = A[o];
              cg = A[o + 1];
              cb = A[o + 2];
              ca = A[o + 3];
            }
            cr += (B[o] - cr) * t;
            cg += (B[o + 1] - cg) * t;
            cb += (B[o + 2] - cb) * t;
            ca += (B[o + 3] - ca) * t;
          }
          const a8 = round8(ca);
          if (a8 === 0) {
            d[i] = d[i + 1] = d[i + 2] = d[i + 3] = 0;
            continue;
          }
          const s = 255 / ca;
          d[i] = round8(cr * s);
          d[i + 1] = round8(cg * s);
          d[i + 2] = round8(cb * s);
          d[i + 3] = a8;
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Grain (the Noise tab): added after the blur, only where something was blurred

/** Position-stable 32-bit hash. */
function hash3(x, y, z) {
  let h = (Math.imul(x | 0, 0x27d4eb2d) + Math.imul(y | 0, 0x165667b1) + Math.imul(z | 0, 0x9e3779b1)) | 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** Zero-mean noise value from a hash: uniform in -1..1, or roughly normal with sigma 0.5 (four bytes summed). */
const grainValue = (h, gaussian) =>
  gaussian ? (((h & 255) + ((h >>> 8) & 255) + ((h >>> 16) & 255) + (h >>> 24)) / 255 - 2) * 0.866 : h / 2147483648 - 1;

/**
 * One stream of value noise: the four lattice values of the cell last asked about are kept, so
 * walking along a row costs four hashes per cell instead of per pixel. The value depends on the
 * seed and the position only.
 */
const grainStream = (seed, gaussian) => ({ seed, gaussian, cx: NaN, cy: NaN, a: 0, b: 0, c: 0, e: 0 });

/** Value of a stream in cell (x0, y0) at the fractions (fx, fy): bilinear between the cell's corners. */
function grainCell(st, x0, y0, fx, fy) {
  if (x0 !== st.cx || y0 !== st.cy) {
    st.cx = x0;
    st.cy = y0;
    st.a = grainValue(hash3(x0, y0, st.seed), st.gaussian);
    st.b = grainValue(hash3(x0 + 1, y0, st.seed), st.gaussian);
    st.c = grainValue(hash3(x0, y0 + 1, st.seed), st.gaussian);
    st.e = grainValue(hash3(x0 + 1, y0 + 1, st.seed), st.gaussian);
  }
  // bilinear mixing lowers the variance between lattice points; 1.5 brings the average back
  return (st.a + (st.b - st.a) * fx + (st.c - st.a + (st.a - st.b - st.c + st.e) * fx) * fy) * 1.5;
}

/**
 * Adds grain inside r, weighted by how much each pixel was blurred (`amount` holds that in px per
 * pixel of `mr`). noise: { amount 0..100, size 1..100 (cell size: white noise at 1, soft clumps
 * above), roughness 0..100 (patchiness), color 0..100 (0 = mono), highlights 0..100 (how much
 * grain the highlights keep), distribution 'uniform' | 'gaussian', seed }.
 */
function addGrain(img, r, noise, amount, mr) {
  const level = clampNum(num(noise?.amount, 0), 0, 100) / 100;
  if (!(level > 0)) return;
  const size = clampNum(num(noise.size, 1), 1, 100);
  const rough = clampNum(num(noise.roughness, 0), 0, 100) / 100;
  const color = clampNum(num(noise.color, 0), 0, 100) / 100;
  const keep = clampNum(num(noise.highlights, 0), 0, 100) / 100;
  const gaussian = noise.distribution !== 'uniform';
  const seed = num(noise.seed, 1) | 0;
  const A = level * GRAIN_LEVELS, white = size <= 1;
  const mono = grainStream(seed, gaussian), patch = grainStream(seed + 101, false);
  const red = grainStream(seed + 17, gaussian), green = grainStream(seed + 31, gaussian), blue = grainStream(seed + 47, gaussian);
  // lattice cell and fraction of every column, for the grain and for the (four times coarser) patches
  const cellX = new Int32Array(r.width), fracX = new Float32Array(r.width), patchX = new Int32Array(r.width), patchFx = new Float32Array(r.width);
  for (let x = 0; x < r.width; x++) {
    const u = (r.x + x) / size, w = u / 4;
    cellX[x] = Math.floor(u);
    fracX[x] = u - cellX[x];
    patchX[x] = Math.floor(w);
    patchFx[x] = w - patchX[x];
  }
  const d = img.data, W = img.width;
  for (let y = r.y; y < r.y + r.height; y++) {
    let p = (y - mr.y) * mr.width + (r.x - mr.x);
    let i = (y * W + r.x) * 4;
    const v = y / size, y0 = Math.floor(v), fy = v - y0, py = Math.floor(v / 4), pfy = v / 4 - py;
    for (let k = 0; k < r.width; k++, p++, i += 4) {
      const blur = amount[p];
      if (!(blur > EPS) || d[i + 3] === 0) continue;
      const x = r.x + k;
      let g = A * (blur >= 1.5 ? 1 : smoothstep(0, 1.5, blur));
      if (rough > 0) g *= Math.max(0, 1 - rough + 2 * rough * (grainCell(patch, patchX[k], py, patchFx[k], pfy) * 0.5 + 0.5));
      if (keep < 1) {
        const L = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
        if (L > 128) g *= 1 - (1 - keep) * smoothstep(128, 255, L);
      }
      const n0 = white ? grainValue(hash3(x, y, seed), gaussian) : grainCell(mono, cellX[k], y0, fracX[k], fy);
      if (color > 0) {
        const m = n0 * (1 - color);
        const nr = white ? grainValue(hash3(x, y, seed + 17), gaussian) : grainCell(red, cellX[k], y0, fracX[k], fy);
        const ng = white ? grainValue(hash3(x, y, seed + 31), gaussian) : grainCell(green, cellX[k], y0, fracX[k], fy);
        const nb = white ? grainValue(hash3(x, y, seed + 47), gaussian) : grainCell(blue, cellX[k], y0, fracX[k], fy);
        d[i] = round8(d[i] + g * (m + color * nr));
        d[i + 1] = round8(d[i + 1] + g * (m + color * ng));
        d[i + 2] = round8(d[i + 2] + g * (m + color * nb));
      } else {
        const n = g * n0;
        d[i] = round8(d[i] + n);
        d[i + 1] = round8(d[i + 1] + n);
        d[i + 2] = round8(d[i + 2] + n);
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Radius maps of the lens kinds

const pinList = (pins) => (Array.isArray(pins) ? pins.filter((p) => p && typeof p === 'object') : []);
const blurOf = (pin) => clampNum(num(pin.blur, 0), 0, MAX_BLUR);

/** Field Blur: inverse-distance-weighted (1 / d^2) interpolation of the pins' blur. */
function fieldRadius(pins, W, H, r) {
  const n = pins.length;
  const px = pins.map((p) => num(p.x, 0.5) * W), py = pins.map((p) => num(p.y, 0.5) * H), pb = pins.map(blurOf);
  if (pb.every((b) => b === pb[0])) return { uniform: pb[0], map: null };
  const map = new Float32Array(r.width * r.height);
  for (let y = 0, p = 0; y < r.height; y++) {
    const cy = r.y + y + 0.5;
    for (let x = 0; x < r.width; x++, p++) {
      const cx = r.x + x + 0.5;
      let sw = 0, sb = 0, hit = -1;
      for (let k = 0; k < n; k++) {
        const dx = cx - px[k], dy = cy - py[k], d2 = dx * dx + dy * dy;
        if (d2 < 1e-6) {
          hit = k;
          break;
        }
        const w = 1 / d2;
        sw += w;
        sb += w * pb[k];
      }
      map[p] = hit >= 0 ? pb[hit] : sb / sw;
    }
  }
  return { uniform: null, map };
}

/** Geometry of an ellipse pin in px: centre, radii, rotation. */
function ellipseOf(pin, W, H) {
  const rot = num(pin.rotation, 0) * DEG;
  return {
    cx: num(pin.x, 0.5) * W,
    cy: num(pin.y, 0.5) * H,
    rx: Math.max(0.5, Math.abs(num(pin.rx, 0.3)) * W),
    ry: Math.max(0.5, Math.abs(num(pin.ry, 0.3)) * H),
    cos: Math.cos(rot),
    sin: Math.sin(rot),
    feather: clampNum(num(pin.feather, 0.5), 0, 1),
  };
}

/** Superellipse exponent of an iris pin: 2 is the ellipse, 8 nearly a rectangle (roundness 100), 1 a diamond (-100). */
export const irisExponent = (roundness) => {
  const q = clampNum(num(roundness, 0), -100, 100) / 100;
  return q >= 0 ? 2 + 6 * q : 2 + q;
};

/** Iris Blur: sharp inside the inner ring (feather * radius), full blur outside the shape; the minimum over the pins. */
function irisRadius(pins, W, H, r) {
  const es = pins.map((p) => ({ ...ellipseOf(p, W, H), blur: blurOf(p), n: irisExponent(p.roundness) }));
  const map = new Float32Array(r.width * r.height);
  for (let y = 0, p = 0; y < r.height; y++) {
    const cy = r.y + y + 0.5;
    for (let x = 0; x < r.width; x++, p++) {
      const cx = r.x + x + 0.5;
      let best = Infinity;
      for (let k = 0; k < es.length; k++) {
        const e = es[k];
        const dx = cx - e.cx, dy = cy - e.cy;
        const u = Math.abs(e.cos * dx + e.sin * dy) / e.rx, v = Math.abs(-e.sin * dx + e.cos * dy) / e.ry;
        let b = e.blur;
        // outside the shape's bounding box the blur is full whatever the exponent (and no pow is needed)
        if (u < 1 && v < 1) {
          const rho = e.n === 2 ? Math.sqrt(u * u + v * v) : Math.pow(Math.pow(u, e.n) + Math.pow(v, e.n), 1 / e.n);
          if (rho < 1) b = rho <= e.feather ? 0 : e.blur * smoothstep(e.feather, 1, rho);
        }
        if (b < best) best = b;
      }
      map[p] = best;
    }
  }
  return map;
}

/** Geometry of a tilt-shift pin in px: the band's centre line through (cx, cy) along (cos, sin). */
function bandOf(pin, W, H) {
  const rot = num(pin.rotation, 0) * DEG;
  return {
    cx: num(pin.x, 0.5) * W,
    cy: num(pin.y, 0.5) * H,
    cos: Math.cos(rot),
    sin: Math.sin(rot),
    focus: Math.max(0, num(pin.focus, 0.15)) * H,
    fade: Math.max(0, num(pin.fade, 0.3)) * H,
    blur: blurOf(pin),
  };
}

/** Tilt-Shift: no blur within `focus` of the centre line, a linear ramp over `fade`, full blur beyond; the minimum over the pins. */
function tiltRadius(bands, r) {
  const map = new Float32Array(r.width * r.height);
  for (let y = 0, p = 0; y < r.height; y++) {
    const cy = r.y + y + 0.5;
    for (let x = 0; x < r.width; x++, p++) {
      const cx = r.x + x + 0.5;
      let best = Infinity;
      for (let k = 0; k < bands.length; k++) {
        const b = bands[k];
        const dist = Math.abs(-b.sin * (cx - b.cx) + b.cos * (cy - b.cy)) - b.focus;
        const v = dist <= 0 ? 0 : dist >= b.fade ? b.blur : (b.blur * dist) / b.fade;
        if (v < best) best = v;
      }
      map[p] = best;
    }
  }
  return map;
}

// ---------------------------------------------------------------------------------------------
// Bilinear taps (premultiplied accumulation; coordinates are clamped: edges replicate)

/** Adds wgt * the bilinear sample of the 8-bit image at (sx, sy) to acc as [r*a, g*a, b*a, a]. */
function tap8(src, W, H, sx, sy, acc, wgt) {
  let fx = sx - 0.5, fy = sy - 0.5;
  if (fx < 0) fx = 0;
  else if (fx > W - 1) fx = W - 1;
  if (fy < 0) fy = 0;
  else if (fy > H - 1) fy = H - 1;
  const x0 = fx | 0, y0 = fy | 0, tx = fx - x0, ty = fy - y0;
  const i00 = (y0 * W + x0) * 4, i10 = x0 + 1 < W ? i00 + 4 : i00, down = y0 + 1 < H ? W * 4 : 0;
  const i01 = i00 + down, i11 = i10 + down;
  const a00 = src[i00 + 3] * (1 - tx) * (1 - ty) * wgt, a10 = src[i10 + 3] * tx * (1 - ty) * wgt;
  const a01 = src[i01 + 3] * (1 - tx) * ty * wgt, a11 = src[i11 + 3] * tx * ty * wgt;
  acc[0] += src[i00] * a00 + src[i10] * a10 + src[i01] * a01 + src[i11] * a11;
  acc[1] += src[i00 + 1] * a00 + src[i10 + 1] * a10 + src[i01 + 1] * a01 + src[i11 + 1] * a11;
  acc[2] += src[i00 + 2] * a00 + src[i10 + 2] * a10 + src[i01 + 2] * a01 + src[i11 + 2] * a11;
  acc[3] += a00 + a10 + a01 + a11;
}

/** The same for a float [r*a, g*a, b*a, a] buffer covering (bx, by, bw, bh) of the image. */
function tapF(buf, bx, by, bw, bh, sx, sy, acc, wgt) {
  let fx = sx - 0.5 - bx, fy = sy - 0.5 - by;
  if (fx < 0) fx = 0;
  else if (fx > bw - 1) fx = bw - 1;
  if (fy < 0) fy = 0;
  else if (fy > bh - 1) fy = bh - 1;
  const x0 = fx | 0, y0 = fy | 0, tx = fx - x0, ty = fy - y0;
  const i00 = (y0 * bw + x0) * 4, i10 = x0 + 1 < bw ? i00 + 4 : i00, down = y0 + 1 < bh ? bw * 4 : 0;
  const i01 = i00 + down, i11 = i10 + down;
  const w00 = (1 - tx) * (1 - ty) * wgt, w10 = tx * (1 - ty) * wgt, w01 = (1 - tx) * ty * wgt, w11 = tx * ty * wgt;
  acc[0] += buf[i00] * w00 + buf[i10] * w10 + buf[i01] * w01 + buf[i11] * w11;
  acc[1] += buf[i00 + 1] * w00 + buf[i10 + 1] * w10 + buf[i01 + 1] * w01 + buf[i11 + 1] * w11;
  acc[2] += buf[i00 + 2] * w00 + buf[i10 + 2] * w10 + buf[i01 + 2] * w01 + buf[i11 + 2] * w11;
  acc[3] += buf[i00 + 3] * w00 + buf[i10 + 3] * w10 + buf[i01 + 3] * w01 + buf[i11 + 3] * w11;
}

/** Writes an accumulated [r*a, g*a, b*a, a] (total weight wsum) as a straight-alpha pixel. */
function storeAcc(d, i, acc, wsum) {
  const a = acc[3];
  const a8 = round8(a / wsum);
  if (a8 === 0 || !(a > 0)) {
    d[i] = d[i + 1] = d[i + 2] = d[i + 3] = 0;
    return;
  }
  d[i] = round8(acc[0] / a);
  d[i + 1] = round8(acc[1] / a);
  d[i + 2] = round8(acc[2] / a);
  d[i + 3] = a8;
}

/** Number of taps per pass for a kernel of `len` px: n * n taps cover it about one px apart. */
const tapsFor = (len) => clampNum(Math.ceil(Math.sqrt(len)), 2, 16);

// ---------------------------------------------------------------------------------------------
// Field Blur, Iris Blur, Tilt-Shift

function fieldBlur(img, p, rect) {
  const r = region(img, rect);
  const pins = pinList(p.pins);
  if (isEmptyRegion(r) || !pins.length) return img;
  const { uniform, map } = fieldRadius(pins, img.width, img.height, r);
  variableBlur(img, r, map, r, { uniform, lut: bokehLuts(p.bokeh) });
  if (num(p.noise?.amount, 0) > 0) addGrain(img, r, p.noise, map ?? new Float32Array(r.width * r.height).fill(uniform), r);
  return img;
}

function irisBlur(img, p, rect) {
  const r = region(img, rect);
  const pins = pinList(p.pins);
  if (isEmptyRegion(r) || !pins.length) return img;
  const map = irisRadius(pins, img.width, img.height, r);
  variableBlur(img, r, map, r, { lut: bokehLuts(p.bokeh) });
  addGrain(img, r, p.noise, map, r);
  return img;
}

/** Offsets (in sigmas) and weights of the directional Gaussian that stretches the tilt-shift bokeh. */
const STRETCH_TAPS = [-2.4, -1.8, -1.2, -0.6, 0, 0.6, 1.2, 1.8, 2.4].map((o) => [o, Math.exp(-(o * o) / 2)]);

function tiltShift(img, p, rect) {
  const r = region(img, rect);
  const W = img.width, H = img.height;
  const bands = pinList(p.pins).map((pin) => bandOf(pin, W, H));
  if (isEmptyRegion(r) || !bands.length) return img;
  const distortion = clampNum(num(p.distortion, 0), -100, 100) / 100;
  const lut = bokehLuts(p.bokeh);
  if (!distortion) {
    const map = tiltRadius(bands, r);
    variableBlur(img, r, map, r, { lut });
    addGrain(img, r, p.noise, map, r);
    return img;
  }
  // Distortion stretches the blurred image along one axis of the band: across it (positive, the bokeh
  // grows away from the focus line) or along it (negative), by up to the local blur radius, on the far
  // side of the line only unless symmetric. The stretch reads the blurred pixels around rect, so those
  // are blurred into a copy first.
  const reach = Math.ceil(2.4 * Math.abs(distortion) * Math.max(...bands.map((b) => b.blur))) + 2;
  const g = region(img, { x: r.x - reach, y: r.y - reach, width: r.width + 2 * reach, height: r.height + 2 * reach });
  const map = tiltRadius(bands, g);
  const work = { width: W, height: H, data: new Uint8ClampedArray(img.data) };
  variableBlur(work, g, map, g, { lut });
  const symmetric = !!p.symmetricDistortion, strength = Math.abs(distortion);
  const d = img.data, wd = work.data, acc = new Float64Array(4);
  for (let y = r.y; y < r.y + r.height; y++) {
    const cy = y + 0.5;
    let m = (y - g.y) * g.width + (r.x - g.x), i = (y * W + r.x) * 4;
    for (let x = r.x; x < r.x + r.width; x++, m++, i += 4) {
      const rad = map[m];
      if (!(rad > EPS)) continue;
      const cx = x + 0.5;
      // the band that decides this pixel's blur also decides the side and the direction
      let band = bands[0], side = 0, best = Infinity;
      for (let k = 0; k < bands.length; k++) {
        const b = bands[k];
        const sd = -b.sin * (cx - b.cx) + b.cos * (cy - b.cy);
        const dist = Math.abs(sd) - b.focus;
        const v = dist <= 0 ? 0 : dist >= b.fade ? b.blur : (b.blur * dist) / b.fade;
        if (v < best) {
          best = v;
          band = b;
          side = sd;
        }
      }
      const sigma = strength * rad;
      if ((side < 0 && !symmetric) || sigma < 0.3) {
        d[i] = wd[i];
        d[i + 1] = wd[i + 1];
        d[i + 2] = wd[i + 2];
        d[i + 3] = wd[i + 3];
        continue;
      }
      const ux = distortion > 0 ? -band.sin : band.cos, uy = distortion > 0 ? band.cos : band.sin;
      acc[0] = acc[1] = acc[2] = acc[3] = 0;
      let wsum = 0;
      for (let k = 0; k < STRETCH_TAPS.length; k++) {
        const o = STRETCH_TAPS[k][0] * sigma, wgt = STRETCH_TAPS[k][1];
        tap8(wd, W, H, cx + ux * o, cy + uy * o, acc, wgt);
        wsum += wgt;
      }
      storeAcc(d, i, acc, wsum);
    }
  }
  addGrain(img, r, p.noise, map, g);
  return img;
}

// ---------------------------------------------------------------------------------------------
// Spin Blur

function spinBlur(img, p, rect) {
  const r = region(img, rect);
  const pins = pinList(p.pins);
  if (isEmptyRegion(r) || !pins.length) return img;
  return wholeThenRect(img, r, (work) => {
    const W = work.width, H = work.height, d = work.data;
    const amount = new Float32Array(W * H);
    const strobe = p.strobe ? clampNum(num(p.strobeStrength, 50), 0, 100) / 100 : 0;
    const flashes = Math.round(clampNum(num(p.strobeFlashes, 1), 1, 100));
    const acc = new Float64Array(4), acc2 = new Float64Array(4);
    // the pins are applied one after the other, so overlapping ellipses compound
    for (const pin of pins) {
      const e = ellipseOf(pin, W, H);
      const angle = clampNum(num(pin.angle, 0), 0, 360) * DEG;
      if (!(angle > 0)) continue;
      // bounding box of the rotated ellipse
      const ex = Math.hypot(e.rx * e.cos, e.ry * e.sin), ey = Math.hypot(e.rx * e.sin, e.ry * e.cos);
      const bx = Math.max(0, Math.floor(e.cx - ex)), by = Math.max(0, Math.floor(e.cy - ey));
      const bw = Math.min(W, Math.ceil(e.cx + ex)) - bx, bh = Math.min(H, Math.ceil(e.cy + ey)) - by;
      if (bw <= 0 || bh <= 0) continue;
      const n = tapsFor(angle * Math.max(e.rx, e.ry));
      const snap = strobe > 0 ? new Uint8ClampedArray(d) : null;
      const first = new Float32Array(bw * bh * 4), arcs = new Float32Array(bw * bh);
      // pass 1: every pixel averaged over 1/n of its arc (pixels outside the ellipse keep their value)
      for (let y = 0; y < bh; y++) {
        for (let x = 0; x < bw; x++) {
          const o = (y * bw + x) * 4, i = ((by + y) * W + bx + x) * 4;
          const dx = bx + x + 0.5 - e.cx, dy = by + y + 0.5 - e.cy;
          let qx = (e.cos * dx + e.sin * dy) / e.rx, qy = (-e.sin * dx + e.cos * dy) / e.ry;
          const rho2 = qx * qx + qy * qy;
          let a = 0;
          if (rho2 < 1) {
            const rho = Math.sqrt(rho2);
            a = angle * (e.feather >= 1 || rho <= e.feather ? 1 : 1 - smoothstep(e.feather, 1, rho));
          }
          const arc = a * Math.sqrt(dx * dx + dy * dy);
          if (!(arc > EPS)) {
            const al = d[i + 3];
            first[o] = d[i] * al;
            first[o + 1] = d[i + 1] * al;
            first[o + 2] = d[i + 2] * al;
            first[o + 3] = al;
            continue;
          }
          arcs[y * bw + x] = a;
          const step = a / (n * n), start = -a / (2 * n) + step / 2;
          const cd = Math.cos(step), sd = Math.sin(step), c0 = Math.cos(start), s0 = Math.sin(start);
          let t = qx * c0 - qy * s0;
          qy = qx * s0 + qy * c0;
          qx = t;
          acc[0] = acc[1] = acc[2] = acc[3] = 0;
          for (let k = 0; k < n; k++) {
            const ux = qx * e.rx, uy = qy * e.ry;
            tap8(d, W, H, e.cx + e.cos * ux - e.sin * uy, e.cy + e.sin * ux + e.cos * uy, acc, 1);
            t = qx * cd - qy * sd;
            qy = qx * sd + qy * cd;
            qx = t;
          }
          first[o] = acc[0] / n;
          first[o + 1] = acc[1] / n;
          first[o + 2] = acc[2] / n;
          first[o + 3] = acc[3] / n;
        }
      }
      // pass 2: n of those spread over the whole arc
      for (let y = 0; y < bh; y++) {
        for (let x = 0; x < bw; x++) {
          const a = arcs[y * bw + x];
          if (!(a > 0)) continue;
          const i = ((by + y) * W + bx + x) * 4;
          const dx = bx + x + 0.5 - e.cx, dy = by + y + 0.5 - e.cy;
          const q0x = (e.cos * dx + e.sin * dy) / e.rx, q0y = (-e.sin * dx + e.cos * dy) / e.ry;
          const step = a / n, start = -a / 2 + step / 2;
          const cd = Math.cos(step), sd = Math.sin(step);
          let qx = q0x * Math.cos(start) - q0y * Math.sin(start), qy = q0x * Math.sin(start) + q0y * Math.cos(start);
          acc[0] = acc[1] = acc[2] = acc[3] = 0;
          for (let k = 0; k < n; k++) {
            const ux = qx * e.rx, uy = qy * e.ry;
            tapF(first, bx, by, bw, bh, e.cx + e.cos * ux - e.sin * uy, e.cy + e.sin * ux + e.cos * uy, acc, 1);
            const t = qx * cd - qy * sd;
            qy = qx * sd + qy * cd;
            qx = t;
          }
          let wsum = n;
          if (snap) {
            // strobe: `flashes` sharp copies spread over the arc replace part of the continuous blur
            acc2[0] = acc2[1] = acc2[2] = acc2[3] = 0;
            for (let f = 0; f < flashes; f++) {
              const phi = flashes > 1 ? a * (f / (flashes - 1) - 0.5) : 0;
              const c = Math.cos(phi), s = Math.sin(phi);
              const ux = (q0x * c - q0y * s) * e.rx, uy = (q0x * s + q0y * c) * e.ry;
              tap8(snap, W, H, e.cx + e.cos * ux - e.sin * uy, e.cy + e.sin * ux + e.cos * uy, acc2, 1);
            }
            const k1 = (1 - strobe) / n, k2 = strobe / flashes;
            for (let c = 0; c < 4; c++) acc[c] = acc[c] * k1 + acc2[c] * k2;
            wsum = 1;
          }
          storeAcc(d, i, acc, wsum);
          const m = (by + y) * W + bx + x, len = a * Math.sqrt(dx * dx + dy * dy);
          if (len > amount[m]) amount[m] = len;
        }
      }
    }
    addGrain(work, { x: 0, y: 0, width: W, height: H }, p.noise, amount, { x: 0, y: 0, width: W, height: H });
    return work;
  });
}

// ---------------------------------------------------------------------------------------------
// Path Blur

const PATH_STEPS = 16;

/**
 * A path as the polyline the engine and the on-canvas overlay both use: two points are a straight
 * line, more are joined by a Catmull-Rom spline through them. points: [{ x, y }] in px.
 */
export function pathPolyline(points) {
  const pts = (Array.isArray(points) ? points : []).filter((q) => q && Number.isFinite(q.x) && Number.isFinite(q.y));
  if (pts.length < 3) return pts.map((q) => ({ x: q.x, y: q.y }));
  const out = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
    for (let k = 0; k < PATH_STEPS; k++) {
      const t = k / PATH_STEPS, t2 = t * t, t3 = t2 * t;
      out.push({
        x: 0.5 * (2 * p1.x + (p2.x - p0.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (3 * p1.x - p0.x - 3 * p2.x + p3.x) * t3),
        y: 0.5 * (2 * p1.y + (p2.y - p0.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (3 * p1.y - p0.y - 3 * p2.y + p3.y) * t3),
      });
    }
  }
  const last = pts[pts.length - 1];
  out.push({ x: last.x, y: last.y });
  return out;
}

/** Segments of every path in px with their tangent and the blur length (px) at both ends. */
function pathSegments(p, W, H) {
  const speed = clampNum(num(p.speed, 50), 0, 500) / 100;
  const paths = [];
  for (const path of Array.isArray(p.paths) ? p.paths : []) {
    const line = pathPolyline((path?.points ?? []).map((q) => ({ x: num(q?.x, NaN) * W, y: num(q?.y, NaN) * H })));
    const e0 = clampNum(num(path?.endSpeeds?.[0], 50), 0, MAX_BLUR) * speed, e1 = clampNum(num(path?.endSpeeds?.[1], 50), 0, MAX_BLUR) * speed;
    const segs = [];
    let total = 0;
    for (let i = 0; i + 1 < line.length; i++) {
      const dx = line[i + 1].x - line[i].x, dy = line[i + 1].y - line[i].y, len = Math.hypot(dx, dy);
      if (!(len > 1e-6)) continue;
      segs.push({ ax: line[i].x, ay: line[i].y, dx, dy, len, tx: dx / len, ty: dy / len, s: total });
      total += len;
    }
    if (!segs.length || !(e0 > 0 || e1 > 0)) continue;
    for (const s of segs) {
      s.l0 = e0 + ((e1 - e0) * s.s) / total;
      s.l1 = e0 + ((e1 - e0) * (s.s + s.len)) / total;
    }
    paths.push(segs);
  }
  return paths;
}

/** Motion vector (px) at a point: the tangent * blur length of the nearest point of each path, the paths mixed by 1 / d^2. */
function motionAt(paths, x, y, out) {
  let sx = 0, sy = 0, sw = 0;
  for (let k = 0; k < paths.length; k++) {
    const segs = paths[k];
    let best = Infinity, vx = 0, vy = 0;
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      let t = ((x - s.ax) * s.dx + (y - s.ay) * s.dy) / (s.len * s.len);
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = s.ax + s.dx * t - x, ey = s.ay + s.dy * t - y, d2 = ex * ex + ey * ey;
      if (d2 < best) {
        best = d2;
        const len = s.l0 + (s.l1 - s.l0) * t;
        vx = s.tx * len;
        vy = s.ty * len;
      }
    }
    if (paths.length === 1) {
      out[0] = vx;
      out[1] = vy;
      return;
    }
    const w = 1 / (best + 1);
    sx += vx * w;
    sy += vy * w;
    sw += w;
  }
  out[0] = sx / sw;
  out[1] = sy / sw;
}

function pathBlur(img, p, rect) {
  const r = region(img, rect);
  if (isEmptyRegion(r)) return img;
  const paths = pathSegments(p, img.width, img.height);
  if (!paths.length) return img;
  return wholeThenRect(img, r, (work) => {
    const W = work.width, H = work.height, d = work.data;
    // the motion field is evaluated on a 4 px grid and interpolated: it is smooth away from the paths' medial axis
    const G = 4, gw = Math.ceil(W / G) + 1, gh = Math.ceil(H / G) + 1;
    const fx = new Float32Array(gw * gh), fy = new Float32Array(gw * gh), v = [0, 0];
    for (let j = 0; j < gh; j++) {
      for (let i = 0; i < gw; i++) {
        motionAt(paths, i * G, j * G, v);
        fx[j * gw + i] = v[0];
        fy[j * gw + i] = v[1];
      }
    }
    const centered = p.centeredBlur !== false;
    const taper = clampNum(num(p.taper, 0), 0, 100) / 100;
    const strobe = p.strobe ? clampNum(num(p.strobeStrength, 50), 0, 100) / 100 : 0;
    const flashes = Math.round(clampNum(num(p.strobeFlashes, 1), 1, 100));
    const n8 = W * H;
    const vx = new Float32Array(n8), vy = new Float32Array(n8), first = new Float32Array(n8 * 4);
    const acc = new Float64Array(4), acc2 = new Float64Array(4);
    // pass 1: every pixel averaged over 1/n of its kernel, centred on it
    for (let y = 0, m = 0; y < H; y++) {
      const gy = (y + 0.5) / G, j0 = Math.floor(gy), ty = gy - j0;
      for (let x = 0; x < W; x++, m++) {
        const gx = (x + 0.5) / G, i0 = Math.floor(gx), tx = gx - i0, g = j0 * gw + i0;
        const mx = (fx[g] * (1 - tx) + fx[g + 1] * tx) * (1 - ty) + (fx[g + gw] * (1 - tx) + fx[g + gw + 1] * tx) * ty;
        const my = (fy[g] * (1 - tx) + fy[g + 1] * tx) * (1 - ty) + (fy[g + gw] * (1 - tx) + fy[g + gw + 1] * tx) * ty;
        const len = Math.sqrt(mx * mx + my * my);
        const o = m * 4, i = o;
        if (len < 0.5) {
          const al = d[i + 3];
          first[o] = d[i] * al;
          first[o + 1] = d[i + 1] * al;
          first[o + 2] = d[i + 2] * al;
          first[o + 3] = al;
          continue;
        }
        vx[m] = mx;
        vy[m] = my;
        const n = tapsFor(len);
        acc[0] = acc[1] = acc[2] = acc[3] = 0;
        for (let k = 0; k < n; k++) {
          const s = ((k + 0.5) / n - 0.5) / n;
          tap8(d, W, H, x + 0.5 + mx * s, y + 0.5 + my * s, acc, 1);
        }
        first[o] = acc[0] / n;
        first[o + 1] = acc[1] / n;
        first[o + 2] = acc[2] / n;
        first[o + 3] = acc[3] / n;
      }
    }
    const snap = strobe > 0 ? new Uint8ClampedArray(d) : null;
    const amount = new Float32Array(n8);
    // pass 2: n of those along the whole kernel (centred on the pixel, or trailing behind it), tapered towards the ends
    for (let y = 0, m = 0; y < H; y++) {
      for (let x = 0; x < W; x++, m++) {
        const mx = vx[m], my = vy[m];
        if (mx === 0 && my === 0) continue;
        const len = Math.sqrt(mx * mx + my * my), n = tapsFor(len);
        acc[0] = acc[1] = acc[2] = acc[3] = 0;
        let wsum = 0;
        for (let k = 0; k < n; k++) {
          const u = (k + 0.5) / n;
          const s = centered ? u - 0.5 : -u;
          const wgt = 1 - taper * 0.98 * (centered ? Math.abs(2 * u - 1) : u);
          tapF(first, 0, 0, W, H, x + 0.5 + mx * s, y + 0.5 + my * s, acc, wgt);
          wsum += wgt;
        }
        if (snap) {
          acc2[0] = acc2[1] = acc2[2] = acc2[3] = 0;
          for (let f = 0; f < flashes; f++) {
            const u = flashes > 1 ? f / (flashes - 1) : centered ? 0.5 : 0;
            const s = centered ? u - 0.5 : -u;
            tap8(snap, W, H, x + 0.5 + mx * s, y + 0.5 + my * s, acc2, 1);
          }
          const k1 = (1 - strobe) / wsum, k2 = strobe / flashes;
          for (let c = 0; c < 4; c++) acc[c] = acc[c] * k1 + acc2[c] * k2;
          wsum = 1;
        }
        storeAcc(d, m * 4, acc, wsum);
        amount[m] = len;
      }
    }
    const all = { x: 0, y: 0, width: W, height: H };
    addGrain(work, all, p.noise, amount, all);
    return work;
  });
}

// ---------------------------------------------------------------------------------------------
// Helpers for callers

/** Kinds of the Blur Gallery in menu order. */
export const BLUR_GALLERY_KINDS = Object.freeze(['field-blur', 'iris-blur', 'tilt-shift', 'path-blur', 'spin-blur']);

/**
 * The params that give the same picture on a copy of the image scaled by `scale` (the session
 * previews on a reduced copy while dragging): everything measured in px is scaled, fractions stay.
 */
export function scaleBlurParams(kind, params, scale) {
  const p = JSON.parse(JSON.stringify(params ?? {}));
  if (!(scale > 0) || scale === 1) return p;
  if (Array.isArray(p.pins)) for (const pin of p.pins) if (pin && typeof pin.blur === 'number') pin.blur *= scale;
  if (Array.isArray(p.paths)) for (const path of p.paths) if (Array.isArray(path?.endSpeeds)) path.endSpeeds = path.endSpeeds.map((s) => (typeof s === 'number' ? s * scale : s));
  if (p.noise && typeof p.noise.size === 'number') p.noise.size = Math.max(1, p.noise.size * scale);
  return p;
}

// ---------------------------------------------------------------------------------------------
// The table

const BOKEH = { lightBokeh: 0, bokehColor: 0, lightRange: [191, 255] };
const NOISE = { amount: 0, size: 1, roughness: 0, color: 0, highlights: 0, distribution: 'gaussian' };

const S = (key, label, min, max, step = 1, extra = {}) => ({ key, label, type: 'slider', min, max, step, ...extra });
// Dialog fields for callers without the on-canvas session (they edit the first pin and the effects)
const BOKEH_FIELDS = [S('bokeh.lightBokeh', 'Light bokeh', 0, 100, 1, { unit: '%' }), S('bokeh.bokehColor', 'Bokeh color', 0, 100, 1, { unit: '%' }), S('bokeh.lightRange.0', 'Light range from', 0, 255), S('bokeh.lightRange.1', 'Light range to', 0, 255)];
const NOISE_FIELDS = [
  S('noise.amount', 'Noise amount', 0, 100, 1, { unit: '%' }), S('noise.size', 'Noise size', 1, 100, 1), S('noise.roughness', 'Noise roughness', 0, 100, 1, { unit: '%' }),
  S('noise.color', 'Noise color', 0, 100, 1, { unit: '%' }), S('noise.highlights', 'Noise highlights', 0, 100, 1, { unit: '%' }),
  { key: 'noise.distribution', label: 'Noise distribution', type: 'segment', options: [['uniform', 'Uniform'], ['gaussian', 'Gaussian']] },
];
const STROBE_FIELDS = [{ key: 'strobe', label: 'Strobe', type: 'checkbox' }, S('strobeStrength', 'Strobe strength', 0, 100, 1, { unit: '%' }), S('strobeFlashes', 'Strobe flashes', 1, 100, 1)];
const BLUR_FIELD = S('pins.0.blur', 'Blur', 0, 500, 1, { unit: 'px' });

// margin 0: with a selection the kinds run on the selection's bounding box, which frames the pins (fractions of that box)
const kind = (name, defaults, fn, fields) => defineFilter(name, 'blur-gallery', defaults, fn, { ui: 'custom', margin: 0, fields });

export const BLUR_GALLERY = Object.freeze({
  'field-blur': kind('Field Blur', { pins: [{ x: 0.5, y: 0.5, blur: 15 }], bokeh: BOKEH, noise: NOISE }, fieldBlur, [BLUR_FIELD, ...BOKEH_FIELDS, ...NOISE_FIELDS]),
  'iris-blur': kind('Iris Blur', { pins: [{ x: 0.5, y: 0.5, blur: 15, rx: 0.3, ry: 0.3, rotation: 0, roundness: 0, feather: 0.5 }], bokeh: BOKEH, noise: NOISE }, irisBlur, [
    BLUR_FIELD, S('pins.0.rx', 'Width', 0.01, 2, 0.01), S('pins.0.ry', 'Height', 0.01, 2, 0.01), S('pins.0.rotation', 'Rotation', -180, 180, 1, { unit: '°' }),
    S('pins.0.roundness', 'Roundness', -100, 100, 1), S('pins.0.feather', 'Sharp area', 0, 1, 0.01), ...BOKEH_FIELDS, ...NOISE_FIELDS,
  ]),
  'tilt-shift': kind('Tilt-Shift', { pins: [{ x: 0.5, y: 0.5, blur: 15, rotation: 0, focus: 0.15, fade: 0.3 }], distortion: 0, symmetricDistortion: false, bokeh: BOKEH, noise: NOISE }, tiltShift, [
    BLUR_FIELD, S('pins.0.rotation', 'Rotation', -180, 180, 1, { unit: '°' }), S('pins.0.focus', 'Focus', 0, 1, 0.01), S('pins.0.fade', 'Transition', 0, 1, 0.01),
    S('distortion', 'Distortion', -100, 100, 1, { unit: '%' }), { key: 'symmetricDistortion', label: 'Symmetric distortion', type: 'checkbox' }, ...BOKEH_FIELDS, ...NOISE_FIELDS,
  ]),
  'path-blur': kind('Path Blur', { paths: [{ points: [{ x: 0.3, y: 0.5 }, { x: 0.7, y: 0.5 }], endSpeeds: [50, 50] }], speed: 50, taper: 0, centeredBlur: true, strobe: false, strobeStrength: 50, strobeFlashes: 1, noise: NOISE }, pathBlur, [
    S('speed', 'Speed', 0, 100, 1, { unit: '%' }), S('taper', 'Taper', 0, 100, 1, { unit: '%' }), { key: 'centeredBlur', label: 'Centered blur', type: 'checkbox' },
    S('paths.0.endSpeeds.0', 'Start speed', 0, 500, 1, { unit: 'px' }), S('paths.0.endSpeeds.1', 'End speed', 0, 500, 1, { unit: 'px' }), ...STROBE_FIELDS, ...NOISE_FIELDS,
  ]),
  'spin-blur': kind('Spin Blur', { pins: [{ x: 0.5, y: 0.5, angle: 15, rx: 0.3, ry: 0.3, rotation: 0, feather: 0.5 }], strobe: false, strobeStrength: 50, strobeFlashes: 1, noise: NOISE }, spinBlur, [
    S('pins.0.angle', 'Blur angle', 0, 360, 1, { unit: '°' }), S('pins.0.rx', 'Width', 0.01, 2, 0.01), S('pins.0.ry', 'Height', 0.01, 2, 0.01), S('pins.0.rotation', 'Rotation', -180, 180, 1, { unit: '°' }),
    S('pins.0.feather', 'Full-strength area', 0, 1, 0.01), ...STROBE_FIELDS, ...NOISE_FIELDS,
  ]),
});
