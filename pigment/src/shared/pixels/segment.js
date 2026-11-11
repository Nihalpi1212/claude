// Segmentation for Select > Subject / Sky / Focus Area and the Object Selection tool (builder
// "select-mask"). Pure, no DOM: typed arrays and plain loops, deterministic.
//
//   saliency(img, { size })                     full-size mask (0..255) of how much each pixel stands out
//   grabCut(img, initMask, opts)                GrabCut: GMM colour models + 8-connected graph cut
//   selectSubject(img)                          saliency -> trimap -> grabCut -> largest parts, holes filled
//   selectSky(img)                              sky prior (colour, position, smoothness, connected to the top) -> grabCut
//   focusArea(img, { range, noise, autoRange }) local Laplacian energy -> threshold -> graph cut cleanup
//   objectSelect(img, rect | polygon)           grabCut with the region as probable foreground
//   maxflowGrid(w, h, cap, tcap)                Boykov-Kolmogorov max-flow on an 8-connected grid
//
// Everything is segmented on a copy reduced to at most `scale` px on its longer side (640 by default:
// a cut of 300 000 nodes takes a few hundred milliseconds), then the labels are brought back to full
// size and the edge is re-estimated from the full-size pixels (matte.js refineEdge in a band as wide
// as one reduced pixel). Masks are Uint8ClampedArray(width * height), 0..255. Transparent pixels
// (alpha < 128) never belong to a result.

import { refineEdge, boxMean } from './matte.js';
import { rasterizePolygon } from './selection-ops.js';

/** @typedef {import('./core.js').ImageDataLike} ImageDataLike */
/** @typedef {import('./core.js').Rect} Rect */

/** Labels of a GrabCut init mask (OpenCV's): sure background, sure foreground, probably background, probably foreground. */
export const GC_BGD = 0, GC_FGD = 1, GC_PR_BGD = 2, GC_PR_FGD = 3;

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep = (a, b, v) => {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};

// ---- reduced copies ---------------------------------------------------------------------------------------------------

/**
 * Area-averaged copy of a region of img, at most maxSide px on its longer side (never enlarged).
 * Colours are averaged by alpha. @returns {{ width, height, scale, rgb: Float32Array, alpha: Float32Array, rect: Rect }}
 */
function reduce(img, maxSide, rect = null) {
  const r = rect ?? { x: 0, y: 0, width: img.width, height: img.height };
  const scale = Math.min(1, maxSide / Math.max(r.width, r.height));
  const w = Math.max(1, Math.round(r.width * scale)), h = Math.max(1, Math.round(r.height * scale));
  const n = w * h, rgb = new Float32Array(n * 3), alpha = new Float32Array(n);
  const d = img.data, W = img.width;
  const xs = new Int32Array(w + 1), ys = new Int32Array(h + 1);
  for (let x = 0; x <= w; x++) xs[x] = Math.min(r.width, Math.round((x * r.width) / w));
  for (let y = 0; y <= h; y++) ys[y] = Math.min(r.height, Math.round((y * r.height) / h));
  for (let y = 0; y < h; y++) {
    const ya = ys[y], yb = Math.max(ya + 1, ys[y + 1]);
    for (let x = 0; x < w; x++) {
      const xa = xs[x], xb = Math.max(xa + 1, xs[x + 1]);
      let sr = 0, sg = 0, sb = 0, sa = 0;
      for (let yy = ya; yy < yb; yy++) {
        let i = ((r.y + yy) * W + r.x + xa) * 4;
        for (let xx = xa; xx < xb; xx++, i += 4) {
          const a = d[i + 3];
          sr += d[i] * a;
          sg += d[i + 1] * a;
          sb += d[i + 2] * a;
          sa += a;
        }
      }
      const o = y * w + x;
      if (sa > 0) {
        rgb[o * 3] = sr / sa;
        rgb[o * 3 + 1] = sg / sa;
        rgb[o * 3 + 2] = sb / sa;
      }
      alpha[o] = sa / (255 * (yb - ya) * (xb - xa));
    }
  }
  return { width: w, height: h, scale: w / r.width, rgb, alpha, rect: r };
}

/** Bounds of the pixels with alpha >= 128 and how many of the pixels inside are below it. */
function opaqueBounds(img) {
  const w = img.width, h = img.height, d = img.data;
  let x0 = w, y0 = h, x1 = -1, y1 = -1, count = 0;
  for (let y = 0; y < h; y++) {
    let i = y * w * 4 + 3;
    for (let x = 0; x < w; x++, i += 4) {
      if (d[i] < 128) continue;
      count++;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return null;
  const rect = { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
  return { rect, holes: 1 - count / (rect.width * rect.height) };
}

/** Bilinear resize of a plane. */
function resizePlane(src, sw, sh, dw, dh) {
  if (sw === dw && sh === dh) return src;
  const out = new Float32Array(dw * dh);
  for (let y = 0; y < dh; y++) {
    const fy = Math.max(0, Math.min(sh - 1, ((y + 0.5) * sh) / dh - 0.5)), y0 = Math.floor(fy), y1 = Math.min(sh - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < dw; x++) {
      const fx = Math.max(0, Math.min(sw - 1, ((x + 0.5) * sw) / dw - 0.5)), x0 = Math.floor(fx), x1 = Math.min(sw - 1, x0 + 1), tx = fx - x0;
      const a = src[y0 * sw + x0], b = src[y0 * sw + x1], c = src[y1 * sw + x0], e = src[y1 * sw + x1];
      const top = a + (b - a) * tx;
      out[y * dw + x] = top + (c + (e - c) * tx - top) * ty;
    }
  }
  return out;
}

// ---- colour helpers ---------------------------------------------------------------------------------------------------

const SRGB_LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  SRGB_LINEAR[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
const labF = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);

/** CIE Lab (D65) planes of a reduced copy. */
function toLab(S) {
  const n = S.width * S.height, L = new Float32Array(n), A = new Float32Array(n), B = new Float32Array(n);
  for (let p = 0, i = 0; p < n; p++, i += 3) {
    const r = SRGB_LINEAR[Math.round(S.rgb[i])], g = SRGB_LINEAR[Math.round(S.rgb[i + 1])], b = SRGB_LINEAR[Math.round(S.rgb[i + 2])];
    const fx = labF((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047), fy = labF(0.2126 * r + 0.7152 * g + 0.0722 * b), fz = labF((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883);
    L[p] = 116 * fy - 16;
    A[p] = 500 * (fx - fy);
    B[p] = 200 * (fy - fz);
  }
  return { L, A, B };
}

/**
 * k-means over 3-vectors (points: Float32Array(m * 3)). Deterministic: the first centre is the point
 * nearest the mean, each next one the point farthest from those chosen. Centres are fitted on a
 * stride sample of at most 4096 points, then every point is assigned.
 * @returns {{ k: number, centers: Float64Array, assign: Uint8Array, counts: Int32Array }}
 */
function kmeans(points, m, k, iterations = 8) {
  k = Math.max(1, Math.min(k, m));
  const stride = Math.max(1, Math.floor(m / 4096));
  const sm = Math.ceil(m / stride);
  const centers = new Float64Array(k * 3), counts = new Int32Array(k);
  let mx = 0, my = 0, mz = 0;
  for (let s = 0; s < sm; s++) {
    const i = s * stride * 3;
    mx += points[i];
    my += points[i + 1];
    mz += points[i + 2];
  }
  mx /= sm;
  my /= sm;
  mz /= sm;
  const minD = new Float64Array(sm).fill(Infinity);
  let pick = 0, best = Infinity;
  for (let s = 0; s < sm; s++) {
    const i = s * stride * 3, dd = (points[i] - mx) ** 2 + (points[i + 1] - my) ** 2 + (points[i + 2] - mz) ** 2;
    if (dd < best) {
      best = dd;
      pick = s;
    }
  }
  for (let c = 0; c < k; c++) {
    const pi = pick * stride * 3;
    centers[c * 3] = points[pi];
    centers[c * 3 + 1] = points[pi + 1];
    centers[c * 3 + 2] = points[pi + 2];
    let far = -1;
    pick = 0;
    for (let s = 0; s < sm; s++) {
      const i = s * stride * 3, dd = (points[i] - centers[c * 3]) ** 2 + (points[i + 1] - centers[c * 3 + 1]) ** 2 + (points[i + 2] - centers[c * 3 + 2]) ** 2;
      if (dd < minD[s]) minD[s] = dd;
      if (minD[s] > far) {
        far = minD[s];
        pick = s;
      }
    }
  }
  const nearest = (i) => {
    let bc = 0, bd = Infinity;
    for (let c = 0; c < k; c++) {
      const dd = (points[i] - centers[c * 3]) ** 2 + (points[i + 1] - centers[c * 3 + 1]) ** 2 + (points[i + 2] - centers[c * 3 + 2]) ** 2;
      if (dd < bd) {
        bd = dd;
        bc = c;
      }
    }
    return bc;
  };
  const sums = new Float64Array(k * 3);
  for (let it = 0; it < iterations; it++) {
    sums.fill(0);
    counts.fill(0);
    for (let s = 0; s < sm; s++) {
      const i = s * stride * 3, c = nearest(i);
      sums[c * 3] += points[i];
      sums[c * 3 + 1] += points[i + 1];
      sums[c * 3 + 2] += points[i + 2];
      counts[c]++;
    }
    for (let c = 0; c < k; c++) if (counts[c]) {
      centers[c * 3] = sums[c * 3] / counts[c];
      centers[c * 3 + 1] = sums[c * 3 + 1] / counts[c];
      centers[c * 3 + 2] = sums[c * 3 + 2] / counts[c];
    }
  }
  const assign = new Uint8Array(m);
  counts.fill(0);
  for (let p = 0; p < m; p++) {
    const c = nearest(p * 3);
    assign[p] = c;
    counts[c]++;
  }
  return { k, centers, assign, counts };
}

/** Otsu's threshold of values in 0..1 (256 bins). */
function otsu(values, n = values.length) {
  const hist = new Float64Array(256);
  for (let i = 0; i < n; i++) hist[Math.min(255, Math.max(0, Math.round(values[i] * 255)))]++;
  let total = 0;
  for (let i = 0; i < 256; i++) total += i * hist[i];
  let wB = 0, sumB = 0, best = -1, at = 127;
  for (let i = 0; i < 256; i++) {
    wB += hist[i];
    if (!wB) continue;
    const wF = n - wB;
    if (!wF) break;
    sumB += i * hist[i];
    const diff = sumB / wB - (total - sumB) / wF, v = wB * wF * diff * diff;
    if (v > best) {
      best = v;
      at = i;
    }
  }
  return (at + 0.5) / 255;
}

// ---- max-flow ---------------------------------------------------------------------------------------------------------

const TERMINAL = 8, ORPHAN = 9, FREE = -1;

/**
 * Boykov-Kolmogorov max-flow / min-cut on an 8-connected grid.
 * Directions d = 0..7 are (+1,0) (+1,+1) (0,+1) (-1,+1) (-1,0) (-1,-1) (0,-1) (+1,-1); the reverse of d is d ^ 4.
 * @param {number} w @param {number} h
 * @param {Int32Array} cap w*h*8 capacities of the arc from each node in each direction (0 where the
 *   neighbour is outside the grid); residual capacities afterwards
 * @param {Int32Array} tcap w*h terminal capacities, source minus sink (> 0 ties the node to the
 *   source, < 0 to the sink); residuals afterwards
 * @returns {{ source: Uint8Array, flow: number }} source[i] = 1 for the nodes on the source side of the cut
 */
export function maxflowGrid(w, h, cap, tcap) {
  const n = w * h;
  const off = Int32Array.of(1, w + 1, w, w - 1, -1, -w - 1, -w, -w + 1);
  const parent = new Int8Array(n).fill(FREE); // direction towards the parent, TERMINAL, ORPHAN or FREE
  const tree = new Uint8Array(n); // 0 = source tree, 1 = sink tree (meaningful while parent != FREE)
  const ts = new Int32Array(n), dist = new Int32Array(n);
  const next = new Int32Array(n).fill(-1); // active list links: -1 = not listed, self = last
  let qf0 = -1, qf1 = -1, ql1 = -1;
  const ring = n + 1, orphans = new Int32Array(ring);
  let oh = 0, ot = 0, time = 0, flow = 0;

  const setActive = (i) => {
    if (next[i] !== -1) return;
    if (ql1 >= 0) next[ql1] = i;
    else qf1 = i;
    ql1 = i;
    next[i] = i;
  };
  const nextActive = () => {
    for (;;) {
      let i = qf0;
      if (i < 0) {
        qf0 = i = qf1;
        qf1 = -1;
        ql1 = -1;
        if (i < 0) return -1;
      }
      qf0 = next[i] === i ? -1 : next[i];
      next[i] = -1;
      if (parent[i] !== FREE) return i;
    }
  };

  for (let i = 0; i < n; i++) {
    if (tcap[i] === 0) continue;
    tree[i] = tcap[i] > 0 ? 0 : 1;
    parent[i] = TERMINAL;
    dist[i] = 1;
    setActive(i);
  }

  /** Pushes the bottleneck along source .. s -(d)-> t .. sink; saturated tree arcs orphan their child. */
  const augment = (s, d, t) => {
    let b = cap[s * 8 + d], v = s;
    for (;;) {
      const pd = parent[v];
      if (pd === TERMINAL) break;
      const p = v + off[pd], r = cap[p * 8 + (pd ^ 4)];
      if (r < b) b = r;
      v = p;
    }
    if (tcap[v] < b) b = tcap[v];
    v = t;
    for (;;) {
      const pd = parent[v];
      if (pd === TERMINAL) break;
      const r = cap[v * 8 + pd];
      if (r < b) b = r;
      v += off[pd];
    }
    if (-tcap[v] < b) b = -tcap[v];

    cap[s * 8 + d] -= b;
    cap[t * 8 + (d ^ 4)] += b;
    v = s;
    for (;;) {
      const pd = parent[v];
      if (pd === TERMINAL) break;
      const p = v + off[pd], a = p * 8 + (pd ^ 4);
      cap[v * 8 + pd] += b;
      cap[a] -= b;
      if (cap[a] === 0) {
        parent[v] = ORPHAN;
        oh = (oh + ring - 1) % ring;
        orphans[oh] = v;
      }
      v = p;
    }
    tcap[v] -= b;
    if (tcap[v] === 0) {
      parent[v] = ORPHAN;
      oh = (oh + ring - 1) % ring;
      orphans[oh] = v;
    }
    v = t;
    for (;;) {
      const pd = parent[v];
      if (pd === TERMINAL) break;
      const p = v + off[pd], a = v * 8 + pd;
      cap[p * 8 + (pd ^ 4)] += b;
      cap[a] -= b;
      if (cap[a] === 0) {
        parent[v] = ORPHAN;
        oh = (oh + ring - 1) % ring;
        orphans[oh] = v;
      }
      v = p;
    }
    tcap[v] += b;
    if (tcap[v] === 0) {
      parent[v] = ORPHAN;
      oh = (oh + ring - 1) % ring;
      orphans[oh] = v;
    }
    flow += b;
  };

  /** Finds a new parent for an orphan in its own tree, or frees it and orphans its children. */
  const adopt = (i) => {
    const sink = tree[i];
    let best = -1, dmin = 0x7fffffff;
    for (let d = 0; d < 8; d++) {
      const j = i + off[d];
      if (j < 0 || j >= n) continue;
      // the arc that would carry flow between the orphan and its new parent must have room
      if ((sink ? cap[i * 8 + d] : cap[j * 8 + (d ^ 4)]) <= 0 || parent[j] === FREE || tree[j] !== sink) continue;
      let dd = 0, v = j;
      for (;;) {
        if (ts[v] === time) {
          dd += dist[v];
          break;
        }
        const pd = parent[v];
        dd++;
        if (pd === TERMINAL) {
          ts[v] = time;
          dist[v] = 1;
          break;
        }
        if (pd === ORPHAN) {
          dd = 0x7fffffff;
          break;
        }
        v += off[pd];
      }
      if (dd < 0x7fffffff) {
        if (dd < dmin) {
          best = d;
          dmin = dd;
        }
        for (v = j; ts[v] !== time; v += off[parent[v]]) {
          ts[v] = time;
          dist[v] = dd--;
        }
      }
    }
    if (best >= 0) {
      parent[i] = best;
      ts[i] = time;
      dist[i] = dmin + 1;
      return;
    }
    for (let d = 0; d < 8; d++) {
      const j = i + off[d];
      if (j < 0 || j >= n || parent[j] === FREE || tree[j] !== sink) continue;
      if ((sink ? cap[i * 8 + d] : cap[j * 8 + (d ^ 4)]) > 0) setActive(j);
      const pd = parent[j];
      if (pd < TERMINAL && j + off[pd] === i) {
        parent[j] = ORPHAN;
        orphans[ot] = j;
        ot = (ot + 1) % ring;
      }
    }
    parent[i] = FREE;
  };

  let current = -1;
  for (;;) {
    let i = current;
    if (i >= 0) {
      next[i] = -1;
      if (parent[i] === FREE) i = -1;
    }
    if (i < 0) {
      i = nextActive();
      if (i < 0) break;
    }
    // grow the tree of i until it touches the other tree
    let s = -1, sd = 0, t = -1;
    if (tree[i] === 0) {
      const base = i * 8;
      for (let d = 0; d < 8; d++) {
        if (cap[base + d] <= 0) continue;
        const j = i + off[d];
        if (parent[j] === FREE) {
          tree[j] = 0;
          parent[j] = d ^ 4;
          ts[j] = ts[i];
          dist[j] = dist[i] + 1;
          setActive(j);
        } else if (tree[j] === 1) {
          s = i;
          sd = d;
          t = j;
          break;
        } else if (ts[j] <= ts[i] && dist[j] > dist[i]) {
          // a shorter way to the source for a node that is already in the tree
          parent[j] = d ^ 4;
          ts[j] = ts[i];
          dist[j] = dist[i] + 1;
        }
      }
    } else {
      for (let d = 0; d < 8; d++) {
        const j = i + off[d];
        if (j < 0 || j >= n || cap[j * 8 + (d ^ 4)] <= 0) continue;
        if (parent[j] === FREE) {
          tree[j] = 1;
          parent[j] = d ^ 4;
          ts[j] = ts[i];
          dist[j] = dist[i] + 1;
          setActive(j);
        } else if (tree[j] === 0) {
          s = j;
          sd = d ^ 4;
          t = i;
          break;
        } else if (ts[j] <= ts[i] && dist[j] > dist[i]) {
          parent[j] = d ^ 4;
          ts[j] = ts[i];
          dist[j] = dist[i] + 1;
        }
      }
    }
    time++;
    if (s >= 0) {
      next[i] = i; // stays active without being listed
      current = i;
      augment(s, sd, t);
      while (oh !== ot) {
        const o = orphans[oh];
        oh = (oh + 1) % ring;
        adopt(o);
      }
    } else current = -1;
  }
  const source = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (parent[i] !== FREE && tree[i] === 0) source[i] = 1;
  return { source, flow };
}

// ---- GrabCut ----------------------------------------------------------------------------------------------------------

const CAP_SCALE = 64; // capacities are integers: energies times this
const HARD = 1 << 28; // more than everything a node's other arcs can carry

/** Gaussian mixture over RGB fitted to the pixels listed in idx with the components in comp. */
function fitGmm(rgb, idx, comp, K) {
  const cnt = new Float64Array(K), sum = new Float64Array(K * 3), prod = new Float64Array(K * 6);
  for (let s = 0; s < idx.length; s++) {
    const i = idx[s] * 3, c = comp[idx[s]], r = rgb[i], g = rgb[i + 1], b = rgb[i + 2];
    cnt[c]++;
    sum[c * 3] += r;
    sum[c * 3 + 1] += g;
    sum[c * 3 + 2] += b;
    const o = c * 6;
    prod[o] += r * r;
    prod[o + 1] += r * g;
    prod[o + 2] += r * b;
    prod[o + 3] += g * g;
    prod[o + 4] += g * b;
    prod[o + 5] += b * b;
  }
  const mean = new Float64Array(K * 3), inv = new Float64Array(K * 6), coef = new Float64Array(K);
  const total = idx.length || 1;
  for (let c = 0; c < K; c++) {
    if (!cnt[c]) continue;
    const m0 = sum[c * 3] / cnt[c], m1 = sum[c * 3 + 1] / cnt[c], m2 = sum[c * 3 + 2] / cnt[c], o = c * 6;
    // the diagonal term keeps flat colours (synthetic images, clipped skies) from collapsing the Gaussian
    const a11 = prod[o] / cnt[c] - m0 * m0 + 4, a12 = prod[o + 1] / cnt[c] - m0 * m1, a13 = prod[o + 2] / cnt[c] - m0 * m2;
    const a22 = prod[o + 3] / cnt[c] - m1 * m1 + 4, a23 = prod[o + 4] / cnt[c] - m1 * m2, a33 = prod[o + 5] / cnt[c] - m2 * m2 + 4;
    const i11 = a22 * a33 - a23 * a23, i12 = a13 * a23 - a12 * a33, i13 = a12 * a23 - a13 * a22;
    const det = a11 * i11 + a12 * i12 + a13 * i13;
    if (!(det > 1e-12)) continue;
    mean[c * 3] = m0;
    mean[c * 3 + 1] = m1;
    mean[c * 3 + 2] = m2;
    inv[o] = i11 / det;
    inv[o + 1] = i12 / det;
    inv[o + 2] = i13 / det;
    inv[o + 3] = (a11 * a33 - a13 * a13) / det;
    inv[o + 4] = (a12 * a13 - a11 * a23) / det;
    inv[o + 5] = (a11 * a22 - a12 * a12) / det;
    coef[c] = cnt[c] / total / Math.sqrt(det);
  }
  return { K, mean, inv, coef };
}

/** Weighted density of component c at (r, g, b), up to the constant (2 pi)^-1.5. */
function gmmComponent(m, c, r, g, b) {
  if (!m.coef[c]) return 0;
  const x = r - m.mean[c * 3], y = g - m.mean[c * 3 + 1], z = b - m.mean[c * 3 + 2], o = c * 6;
  const q = x * (m.inv[o] * x + m.inv[o + 1] * y + m.inv[o + 2] * z) + y * (m.inv[o + 1] * x + m.inv[o + 3] * y + m.inv[o + 4] * z) + z * (m.inv[o + 2] * x + m.inv[o + 4] * y + m.inv[o + 5] * z);
  return m.coef[c] * Math.exp(-0.5 * q);
}

/**
 * Smoothness arcs: lambda * exp(-beta |colour difference|²) / distance, beta from the mean difference
 * (GrabCut). `isolate` (a flag per pixel) leaves out the arcs between pixels whose flags differ.
 */
function smoothnessArcs(S, lambda, isolate = null) {
  const w = S.width, h = S.height, n = w * h, rgb = S.rgb;
  const DX = [1, 1, 0, -1], DY = [0, 1, 1, 1];
  const diff = new Float32Array(n * 4);
  let sum = 0, count = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x, i = p * 3;
      for (let d = 0; d < 4; d++) {
        const nx = x + DX[d], ny = y + DY[d];
        if (nx < 0 || nx >= w || ny >= h) continue;
        const j = (ny * w + nx) * 3, a = rgb[i] - rgb[j], b = rgb[i + 1] - rgb[j + 1], c = rgb[i + 2] - rgb[j + 2];
        const v = a * a + b * b + c * c;
        diff[p * 4 + d] = v;
        sum += v;
        count++;
      }
    }
  }
  const beta = sum > 0 ? count / (2 * sum) : 0;
  const cap = new Int32Array(n * 8);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      for (let d = 0; d < 4; d++) {
        const nx = x + DX[d], ny = y + DY[d];
        if (nx < 0 || nx >= w || ny >= h) continue;
        if (isolate && isolate[p] !== isolate[ny * w + nx]) continue; // no smoothness across the fence
        const c = Math.max(1, Math.round(((lambda * Math.exp(-beta * diff[p * 4 + d])) / (d & 1 ? Math.SQRT2 : 1)) * CAP_SCALE));
        cap[p * 8 + d] = c;
        cap[(ny * w + nx) * 8 + (d ^ 4)] = c;
      }
    }
  }
  return cap;
}

/**
 * GrabCut on a reduced copy. labels (GC_* per pixel) are updated in place: the probable ones end up
 * on the side the last cut put them. `prior` (probability of foreground per pixel) adds
 * priorWeight * -log(prior) to the data term; colorWeight 0 leaves the colour models out (one cut
 * of the prior with the smoothness term). `isolate`: flags per pixel; pixels with different flags are
 * not tied by the smoothness term (the outside of an Object Selection region teaches the background
 * model but must not drag the part of an object that the region cuts through to its side).
 * @returns {Uint8Array} 1 = foreground
 */
function cutReduced(S, labels, { iterations = 5, gmmComponents = 5, lambda = 50, prior = null, priorWeight = 1, colorWeight = 1, isolate = null, stats = null } = {}) {
  const w = S.width, h = S.height, n = w * h, rgb = S.rgb;
  const out = new Uint8Array(n);
  for (let p = 0; p < n; p++) if (S.alpha[p] < 0.5) labels[p] = GC_BGD;
  let nf = 0, nb = 0;
  for (let p = 0; p < n; p++) (labels[p] & 1 ? nf++ : nb++);
  const fin = () => {
    for (let p = 0; p < n; p++) out[p] = labels[p] & 1;
    return out;
  };
  if (!nf || !nb) return fin();
  const t0 = now();
  const arcs = smoothnessArcs(S, lambda, isolate), cap = new Int32Array(n * 8), tcap = new Int32Array(n);
  const useColor = colorWeight > 0, K = Math.max(1, Math.min(8, gmmComponents | 0));
  const comp = new Uint8Array(n);
  let fgModel = null, bgModel = null;
  const split = () => {
    let f = 0;
    for (let p = 0; p < n; p++) f += labels[p] & 1;
    const fg = new Int32Array(f), bg = new Int32Array(n - f);
    for (let p = 0, a = 0, b = 0; p < n; p++) (labels[p] & 1 ? (fg[a++] = p) : (bg[b++] = p));
    return [fg, bg];
  };
  if (useColor) {
    // components start from a k-means of each side's colours
    for (const idx of split()) {
      const pts = new Float32Array(idx.length * 3);
      for (let s = 0; s < idx.length; s++) {
        pts[s * 3] = rgb[idx[s] * 3];
        pts[s * 3 + 1] = rgb[idx[s] * 3 + 1];
        pts[s * 3 + 2] = rgb[idx[s] * 3 + 2];
      }
      const km = kmeans(pts, idx.length, K);
      for (let s = 0; s < idx.length; s++) comp[idx[s]] = km.assign[s];
    }
  }
  const rounds = useColor ? Math.max(1, iterations | 0) : 1;
  let cuts = 0;
  for (let it = 0; it < rounds; it++) {
    if (useColor) {
      const [fg, bg] = split();
      if (!fg.length || !bg.length) break;
      if (it > 0) {
        // each pixel moves to the component of its side that explains it best
        for (const [idx, m] of [[fg, fgModel], [bg, bgModel]]) {
          for (let s = 0; s < idx.length; s++) {
            const p = idx[s], i = p * 3;
            let bc = 0, bv = -1;
            for (let c = 0; c < K; c++) {
              const v = gmmComponent(m, c, rgb[i], rgb[i + 1], rgb[i + 2]);
              if (v > bv) {
                bv = v;
                bc = c;
              }
            }
            comp[p] = bc;
          }
        }
      }
      fgModel = fitGmm(rgb, fg, comp, K);
      bgModel = fitGmm(rgb, bg, comp, K);
    }
    for (let p = 0; p < n; p++) {
      const l = labels[p];
      if (l === GC_FGD) tcap[p] = HARD;
      else if (l === GC_BGD) tcap[p] = -HARD;
      else {
        let e = 0; // energy of background minus energy of foreground: positive pulls to the source (foreground)
        if (useColor) {
          const i = p * 3, r = rgb[i], g = rgb[i + 1], b = rgb[i + 2];
          let pf = 0, pb = 0;
          for (let c = 0; c < K; c++) {
            pf += gmmComponent(fgModel, c, r, g, b);
            pb += gmmComponent(bgModel, c, r, g, b);
          }
          e += colorWeight * (Math.log(pf + 1e-300) - Math.log(pb + 1e-300));
        }
        if (prior) {
          const q = Math.min(0.999, Math.max(0.001, prior[p]));
          e += priorWeight * (Math.log(q) - Math.log(1 - q));
        }
        tcap[p] = Math.max(-HARD / 2, Math.min(HARD / 2, Math.round(e * CAP_SCALE)));
      }
    }
    cap.set(arcs);
    const { source } = maxflowGrid(w, h, cap, tcap);
    cuts++;
    let changed = 0;
    for (let p = 0; p < n; p++) {
      const l = labels[p];
      if (l === GC_FGD || l === GC_BGD) continue;
      const nl = source[p] ? GC_PR_FGD : GC_PR_BGD;
      if (nl !== l) {
        labels[p] = nl;
        changed++;
      }
    }
    if (changed < n * 0.0005) break;
  }
  if (stats) {
    stats.cutMs = (stats.cutMs ?? 0) + now() - t0;
    stats.cuts = (stats.cuts ?? 0) + cuts;
    stats.nodes = n;
  }
  return fin();
}

// ---- cleaning and bringing labels back to full size -----------------------------------------------------------------

/** 4-connected components of the pixels equal to `value`. @returns {{ id: Int32Array, sizes: number[], border: boolean[] }} */
function components(bin, w, h, value) {
  const n = w * h, id = new Int32Array(n).fill(-1), stack = new Int32Array(n);
  const sizes = [], border = [];
  for (let start = 0; start < n; start++) {
    if (bin[start] !== value || id[start] >= 0) continue;
    const c = sizes.length;
    let top = 0, size = 0, edge = false;
    stack[top++] = start;
    id[start] = c;
    while (top) {
      const p = stack[--top], x = p % w, y = (p - x) / w;
      size++;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) edge = true;
      if (x > 0 && bin[p - 1] === value && id[p - 1] < 0) (id[p - 1] = c), (stack[top++] = p - 1);
      if (x < w - 1 && bin[p + 1] === value && id[p + 1] < 0) (id[p + 1] = c), (stack[top++] = p + 1);
      if (y > 0 && bin[p - w] === value && id[p - w] < 0) (id[p - w] = c), (stack[top++] = p - w);
      if (y < h - 1 && bin[p + w] === value && id[p + w] < 0) (id[p + w] = c), (stack[top++] = p + w);
    }
    sizes.push(size);
    border.push(edge);
  }
  return { id, sizes, border };
}

/**
 * Keeps the foreground parts at least `keep` times the largest one (and at least minArea px) and
 * fills holes of at most `hole` px that do not touch the border. In place; returns bin.
 */
function cleanLabels(bin, w, h, { keep = 0.1, minArea = 0, hole = 0 } = {}) {
  const n = w * h;
  const fg = components(bin, w, h, 1);
  if (fg.sizes.length > 1 || (fg.sizes.length === 1 && fg.sizes[0] < minArea)) {
    const largest = Math.max(...fg.sizes), limit = Math.max(minArea, largest * keep);
    for (let p = 0; p < n; p++) if (bin[p] && fg.sizes[fg.id[p]] < limit) bin[p] = 0;
  }
  if (hole > 0) {
    const bg = components(bin, w, h, 0);
    for (let p = 0; p < n; p++) if (!bin[p] && !bg.border[bg.id[p]] && bg.sizes[bg.id[p]] <= hole) bin[p] = 1;
  }
  return bin;
}

/**
 * Labels of a reduced copy -> a mask of the region at full size, written into `out` (image sized).
 * The enlarged edge is off by up to a reduced pixel, so it is re-estimated from the full-size pixels
 * in a band that wide; hardEdge thresholds the result, otherwise the edge is left anti-aliased.
 */
function finish(img, S, bin, out, { hardEdge = false, stats = null } = {}) {
  const t0 = now();
  const r = S.rect, W = img.width;
  const whole = r.x === 0 && r.y === 0 && r.width === img.width && r.height === img.height;
  const plane = new Float32Array(S.width * S.height);
  for (let p = 0; p < plane.length; p++) plane[p] = bin[p];
  const up = resizePlane(plane, S.width, S.height, r.width, r.height);
  let mask = new Uint8ClampedArray(r.width * r.height);
  let any = false;
  for (let p = 0; p < mask.length; p++) if (up[p] >= 0.5) {
    mask[p] = 255;
    any = true;
  }
  if (any) {
    const sub = whole ? img : cropData(img, r);
    for (let p = 0, i = 3; p < mask.length; p++, i += 4) if (sub.data[i] < 128) mask[p] = 0;
    const band = Math.max(1, Math.min(16, Math.ceil(1.25 / S.scale)));
    mask = refineEdge(sub, mask, { radius: band, mode: 'object', contrast: hardEdge ? 0 : 55 });
    if (hardEdge) for (let p = 0; p < mask.length; p++) mask[p] = mask[p] >= 128 ? 255 : 0;
    for (let p = 0, i = 3; p < mask.length; p++, i += 4) if (sub.data[i] < 128) mask[p] = 0;
  }
  if (whole) out.set(mask);
  else for (let y = 0; y < r.height; y++) out.set(mask.subarray(y * r.width, (y + 1) * r.width), (r.y + y) * W + r.x);
  if (stats) stats.refineMs = (stats.refineMs ?? 0) + now() - t0;
  return out;
}

function cropData(img, r) {
  const data = new Uint8ClampedArray(r.width * r.height * 4), W = img.width;
  for (let y = 0; y < r.height; y++) data.set(img.data.subarray(((r.y + y) * W + r.x) * 4, ((r.y + y) * W + r.x + r.width) * 4), y * r.width * 4);
  return { width: r.width, height: r.height, data };
}

/** GC labels of a full-size init mask on the grid of a reduced copy: sure labels win inside a cell. */
function reduceLabels(init, W, S) {
  const { width: w, height: h, rect: r } = S, labels = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const ya = Math.min(r.height - 1, Math.floor((y * r.height) / h)), yb = Math.max(ya + 1, Math.min(r.height, Math.floor(((y + 1) * r.height) / h)));
    for (let x = 0; x < w; x++) {
      const xa = Math.min(r.width - 1, Math.floor((x * r.width) / w)), xb = Math.max(xa + 1, Math.min(r.width, Math.floor(((x + 1) * r.width) / w)));
      let fgd = 0, bgd = 0, prf = 0, prb = 0;
      for (let yy = ya; yy < yb; yy++) {
        let p = (r.y + yy) * W + r.x + xa;
        for (let xx = xa; xx < xb; xx++, p++) {
          const l = init[p];
          if (l === GC_FGD) fgd++;
          else if (l === GC_BGD) bgd++;
          else if (l === GC_PR_FGD) prf++;
          else prb++;
        }
      }
      // a thin sure stroke must survive the reduction; where both meet, the majority decides
      labels[y * w + x] = fgd || bgd ? (fgd >= bgd ? GC_FGD : GC_BGD) : prf >= prb ? GC_PR_FGD : GC_PR_BGD;
    }
  }
  return labels;
}

/**
 * GrabCut (Rother, Kolmogorov, Blake): Gaussian mixtures of the foreground and background colours
 * (k-means start), an 8-connected graph with contrast-sensitive smoothness, Boykov-Kolmogorov
 * min-cut, repeated until the labels settle.
 * @param {ImageDataLike} img
 * @param {Uint8Array | Uint8ClampedArray} initMask width*height GC_BGD | GC_FGD | GC_PR_BGD | GC_PR_FGD
 * @param {{ iterations?: number, gmmComponents?: number, scale?: number, lambda?: number, hardEdge?: boolean,
 *   rect?: Rect | null, keep?: number, hole?: number, stats?: object }} [opts]
 *   scale: longest side of the copy the cut runs on (640); rect: only this region is segmented (the
 *   rest is background); keep / hole: cleaning of the labels (parts smaller than keep * the largest
 *   are dropped, holes up to `hole` of the foreground area are filled; both off by default)
 * @returns {Uint8ClampedArray} mask 0..255
 */
export function grabCut(img, initMask, opts = {}) {
  const W = img.width, H = img.height, out = new Uint8ClampedArray(W * H);
  const rect = opts.rect ? clipRect(opts.rect, W, H) : null;
  if (!W || !H || (rect && (rect.width <= 0 || rect.height <= 0))) return out;
  const S = reduce(img, Math.max(16, opts.scale ?? 640), rect);
  const labels = reduceLabels(initMask, W, S);
  const bin = cutReduced(S, labels, opts);
  if (opts.keep || opts.hole) {
    let area = 0;
    for (let p = 0; p < bin.length; p++) area += bin[p];
    cleanLabels(bin, S.width, S.height, { keep: opts.keep ?? 0, hole: (opts.hole ?? 0) * area });
  }
  return finish(img, S, bin, out, opts);
}

function clipRect(r, w, h) {
  const x = Math.max(0, Math.floor(r.x)), y = Math.max(0, Math.floor(r.y));
  return { x, y, width: Math.min(w, Math.ceil(r.x + r.width)) - x, height: Math.min(h, Math.ceil(r.y + r.height)) - y };
}

// ---- saliency ---------------------------------------------------------------------------------------------------------

/**
 * Saliency of a reduced copy, 0..1 per pixel: how far each pixel's (slightly blurred) Lab colour is
 * from the image mean (frequency-tuned saliency, Achanta et al.) and from the colours of the image
 * border (what the frame is made of is background), with a mild preference for the centre.
 */
function saliencyReduced(S) {
  const w = S.width, h = S.height, n = w * h;
  const { L, A, B } = toLab(S);
  const tmp = new Float32Array(n), sal = new Float32Array(n);
  let ml = 0, ma = 0, mb = 0, cnt = 0;
  for (let p = 0; p < n; p++) if (S.alpha[p] >= 0.5) {
    ml += L[p];
    ma += A[p];
    mb += B[p];
    cnt++;
  }
  if (!cnt) return sal;
  ml /= cnt;
  ma /= cnt;
  mb /= cnt;
  // transparent pixels have no colour: give them the mean, or the blur would bleed black into their neighbours
  if (cnt < n) for (let p = 0; p < n; p++) if (S.alpha[p] < 0.5) {
    L[p] = ml;
    A[p] = ma;
    B[p] = mb;
  }
  const br = Math.max(1, Math.round(Math.min(w, h) / 160));
  boxMean(L, w, h, br, L, tmp);
  boxMean(A, w, h, br, A, tmp);
  boxMean(B, w, h, br, B, tmp);
  // border colours: k-means of a frame a few pixels wide; small clusters are a subject crossing the frame
  const ring = Math.max(2, Math.round(Math.min(w, h) * 0.04));
  const pts = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (x >= ring && x < w - ring && y >= ring && y < h - ring) continue;
    const p = y * w + x;
    if (S.alpha[p] >= 0.5) pts.push(L[p], A[p], B[p]);
  }
  const m = pts.length / 3;
  let clusters = [];
  if (m >= 8) {
    const km = kmeans(Float32Array.from(pts), m, 4);
    const spread = new Float64Array(km.k);
    for (let s = 0; s < m; s++) {
      const c = km.assign[s];
      spread[c] += (pts[s * 3] - km.centers[c * 3]) ** 2 + (pts[s * 3 + 1] - km.centers[c * 3 + 1]) ** 2 + (pts[s * 3 + 2] - km.centers[c * 3 + 2]) ** 2;
    }
    for (let c = 0; c < km.k; c++) if (km.counts[c]) clusters.push({ l: km.centers[c * 3], a: km.centers[c * 3 + 1], b: km.centers[c * 3 + 2], share: km.counts[c] / m, sd: Math.sqrt(spread[c] / km.counts[c]) });
    const big = clusters.filter((c) => c.share >= 0.15);
    clusters = big.length ? big : [clusters.reduce((a, b) => (b.share > a.share ? b : a))];
  }
  // Differences saturate: a colour 40 Lab units from the background is as much "not background" as one
  // 100 away, so a vivid part of the subject does not push its paler parts down the scale.
  let max = 0;
  for (let y = 0; y < h; y++) {
    const dy = (y + 0.5) / h - 0.5;
    for (let x = 0; x < w; x++) {
      const p = y * w + x, dx = (x + 0.5) / w - 0.5;
      if (S.alpha[p] < 0.5) continue;
      const f = Math.sqrt((L[p] - ml) ** 2 + (A[p] - ma) ** 2 + (B[p] - mb) ** 2);
      let d = Infinity;
      for (const c of clusters) {
        const v = Math.max(0, Math.sqrt((L[p] - c.l) ** 2 + (A[p] - c.a) ** 2 + (B[p] - c.b) ** 2) - 1.5 * c.sd);
        if (v < d) d = v;
      }
      if (d === Infinity) d = f;
      const v = (0.35 * (1 - Math.exp(-f / 25)) + 0.65 * (1 - Math.exp(-d / 18))) * (0.7 + 0.3 * Math.exp(-(dx * dx + dy * dy) / 0.32));
      sal[p] = v;
      if (v > max) max = v;
    }
  }
  boxMean(sal, w, h, br, sal, tmp);
  max = 0;
  for (let p = 0; p < n; p++) if (sal[p] > max) max = sal[p];
  // an image whose most different pixel is still close to the rest has no subject: keep its saliency low
  max = Math.max(max, 0.25);
  for (let p = 0; p < n; p++) sal[p] = S.alpha[p] < 0.5 ? 0 : sal[p] / max;
  return sal;
}

/**
 * Saliency map of an image: how much each pixel stands out from the image as a whole and from its
 * border, computed on a copy of at most `size` px (320) and enlarged.
 * @param {ImageDataLike} img @param {{ size?: number }} [opts]
 * @returns {Uint8ClampedArray} mask 0..255
 */
export function saliency(img, { size = 320 } = {}) {
  const W = img.width, H = img.height, out = new Uint8ClampedArray(W * H);
  if (!W || !H) return out;
  const S = reduce(img, Math.max(8, Math.min(320, size)));
  const up = resizePlane(saliencyReduced(S), S.width, S.height, W, H);
  for (let p = 0; p < out.length; p++) out[p] = up[p] * 255;
  return out;
}

// ---- Select Subject --------------------------------------------------------------------------------------------------

/**
 * Select Subject: the most salient object. Saliency gives a trimap (clearly salient = foreground,
 * clearly not = background, the rest probable either way) and a prior, GrabCut settles the outline on
 * the colours, the largest parts are kept and their holes filled.
 * A layer that is mostly transparent already is a cut-out: its opaque pixels are the subject.
 * @param {ImageDataLike} img @param {{ scale?: number, hardEdge?: boolean, stats?: object }} [opts]
 * @returns {Uint8ClampedArray} mask 0..255
 */
export function selectSubject(img, opts = {}) {
  const W = img.width, H = img.height, out = new Uint8ClampedArray(W * H);
  const ob = W && H ? opaqueBounds(img) : null;
  if (!ob) return out;
  const t0 = now();
  const opaque = () => {
    for (let p = 0, i = 3; p < out.length; p++, i += 4) out[p] = img.data[i];
    return out;
  };
  if (ob.holes > 0.1) return opaque();
  const partial = ob.holes > 0 || ob.rect.width < W || ob.rect.height < H;
  const S = reduce(img, Math.max(16, opts.scale ?? 640), ob.rect);
  const w = S.width, h = S.height, n = w * h;
  const small = reduce(img, 320, ob.rect);
  const sal = resizePlane(saliencyReduced(small), small.width, small.height, w, h);
  const t = Math.min(0.85, Math.max(0.15, otsu(sal, n)));
  const labels = new Uint8Array(n), prior = new Float32Array(n);
  const sure = t + 0.6 * (1 - t), never = 0.3 * t;
  for (let p = 0; p < n; p++) {
    const v = sal[p];
    labels[p] = v >= sure ? GC_FGD : v <= never ? GC_BGD : v >= t ? GC_PR_FGD : GC_PR_BGD;
    prior[p] = 1 / (1 + Math.exp(-(v - t) * 10));
  }
  if (opts.stats) opts.stats.saliencyMs = now() - t0;
  const start = Uint8Array.from(labels);
  let bin = cutReduced(S, labels, { iterations: 4, prior, priorWeight: 0.5, stats: opts.stats });
  cleanLabels(bin, w, h, { keep: 0.12, minArea: 4 });
  let area = 0;
  for (let p = 0; p < n; p++) area += bin[p];
  if (area < n * 0.002 || area > n * 0.98) {
    // the colour models gave up (subject and background share their colours): fall back on the saliency itself
    bin = new Uint8Array(n);
    area = 0;
    for (let p = 0; p < n; p++) if (start[p] & 1) (bin[p] = 1), area++;
    cleanLabels(bin, w, h, { keep: 0.12, minArea: 4 });
  }
  // nothing stands out inside a layer that has transparency around or in it: the layer's own shape is the subject
  if (!area && partial) return opaque();
  cleanLabels(bin, w, h, { keep: 0, hole: Math.max(16, area * 0.03) });
  return finish(img, S, bin, out, opts);
}

// ---- Select Sky -------------------------------------------------------------------------------------------------------

/**
 * Select Sky. The prior of a pixel being sky is the product of its colour (blue, or bright and
 * colourless: clouds, overcast), its smoothness (little local gradient) and its height in the frame;
 * only the areas connected to the top of the image count. GrabCut then follows the horizon and takes
 * in the patches of the same colours (sky between branches).
 * @param {ImageDataLike} img @param {{ scale?: number, hardEdge?: boolean, stats?: object }} [opts]
 * @returns {Uint8ClampedArray} mask 0..255 (empty when the image has no sky)
 */
export function selectSky(img, opts = {}) {
  const W = img.width, H = img.height, out = new Uint8ClampedArray(W * H);
  if (!W || !H) return out;
  const S = reduce(img, Math.max(16, opts.scale ?? 640));
  const w = S.width, h = S.height, n = w * h, rgb = S.rgb;
  const lum = new Float32Array(n), grad = new Float32Array(n), col = new Float32Array(n);
  for (let p = 0, i = 0; p < n; p++, i += 3) lum[p] = 0.299 * rgb[i] + 0.587 * rgb[i + 1] + 0.114 * rgb[i + 2];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = y * w + x;
    const gx = lum[x < w - 1 ? p + 1 : p] - lum[x > 0 ? p - 1 : p], gy = lum[y < h - 1 ? p + w : p] - lum[y > 0 ? p - w : p];
    grad[p] = Math.sqrt(gx * gx + gy * gy) * 0.5;
  }
  boxMean(grad, w, h, Math.max(1, Math.round(Math.max(w, h) / 200)), grad);
  const prior = new Float32Array(n);
  for (let y = 0; y < h; y++) {
    const pos = 1 - 0.8 * smoothstep(0.4, 1, (y + 0.5) / h);
    for (let x = 0; x < w; x++) {
      const p = y * w + x, i = p * 3;
      const r = rgb[i], g = rgb[i + 1], b = rgb[i + 2];
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b), sat = mx > 0 ? (mx - mn) / mx : 0, val = mx / 255;
      let blue = 0;
      if (mx - mn > 1e-3 && b >= r) {
        // hue in degrees; sky runs from cyan-blue to blue-violet
        const hue = mx === b ? 240 + (60 * (r - g)) / (mx - mn) : mx === g ? 120 + (60 * (b - r)) / (mx - mn) : 0;
        blue = smoothstep(165, 195, hue) * (1 - smoothstep(250, 275, hue)) * smoothstep(0.1, 0.28, sat) * smoothstep(0.15, 0.35, val);
      }
      const white = 0.6 * smoothstep(0.72, 0.9, val) * (1 - smoothstep(0.1, 0.25, sat));
      const c = Math.max(blue, white);
      col[p] = c;
      prior[p] = S.alpha[p] < 0.5 ? 0 : c * Math.exp(-((grad[p] / 14) ** 2)) * pos;
    }
  }
  // only what reaches the top tenth of the frame is sky
  const cand = new Uint8Array(n);
  for (let p = 0; p < n; p++) cand[p] = prior[p] > 0.3 ? 1 : 0;
  const cc = components(cand, w, h, 1);
  const top = new Uint8Array(cc.sizes.length), limit = Math.max(1, Math.round(h * 0.1));
  for (let y = 0; y < limit; y++) for (let x = 0; x < w; x++) if (cc.id[y * w + x] >= 0) top[cc.id[y * w + x]] = 1;
  let area = 0;
  const sky = new Float32Array(n);
  for (let p = 0; p < n; p++) if (cand[p] && top[cc.id[p]]) {
    sky[p] = 1;
    area++;
  }
  if (area < n * 0.01) return out;
  // sure sky: the connected area a few pixels in from its edge
  const core = boxMean(sky, w, h, Math.max(2, Math.round(Math.max(w, h) / 120)), new Float32Array(n));
  const labels = new Uint8Array(n), pr = new Float32Array(n);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = y * w + x;
    if (sky[p]) {
      labels[p] = core[p] > 0.999 && prior[p] > 0.5 ? GC_FGD : GC_PR_FGD;
      pr[p] = 0.5 + 0.4 * prior[p];
    } else {
      // nothing sky-coloured is surely background; the bottom of the frame is, when it is not sky-like at all
      labels[p] = col[p] < 0.05 && (y > h * 0.85 || core[p] === 0) ? GC_BGD : GC_PR_BGD;
      pr[p] = 0.1 + 0.3 * col[p];
    }
  }
  const bin = cutReduced(S, labels, { iterations: 3, prior: pr, priorWeight: 1, stats: opts.stats });
  cleanLabels(bin, w, h, { keep: 0, minArea: Math.max(4, n * 0.0005), hole: n * 0.0005 });
  return finish(img, S, bin, out, opts);
}

// ---- Focus Area -------------------------------------------------------------------------------------------------------

const NOISE_LEVELS = { low: 1.5, medium: 4, high: 9 };

/**
 * Sharpness of every place of the image, 0..1, on a reduced grid: the local RMS of the Laplacian of
 * the luminance (taken at up to 1024 px, where blur still shows) above the noise floor, on a log
 * scale relative to the sharpest places. `noise` 'auto' estimates the floor from the median Laplacian.
 * @param {ImageDataLike} img @param {{ noise?: 'auto' | 'low' | 'medium' | 'high', scale?: number }} [opts]
 * @returns {{ width: number, height: number, data: Float32Array, auto: number, S: object }} auto = the In-Focus Range (0..100) Auto picks
 */
export function focusMeasure(img, { noise = 'auto', scale = 512 } = {}) {
  const M = reduce(img, 1024);
  const mw = M.width, mh = M.height, mn = mw * mh;
  const lum = new Float32Array(mn);
  for (let p = 0, i = 0; p < mn; p++, i += 3) lum[p] = 0.299 * M.rgb[i] + 0.587 * M.rgb[i + 1] + 0.114 * M.rgb[i + 2];
  const lap = new Float32Array(mn);
  const hist = new Uint32Array(1024);
  for (let y = 0; y < mh; y++) for (let x = 0; x < mw; x++) {
    const p = y * mw + x;
    const v = Math.abs(4 * lum[p] - lum[x > 0 ? p - 1 : p] - lum[x < mw - 1 ? p + 1 : p] - lum[y > 0 ? p - mw : p] - lum[y < mh - 1 ? p + mw : p]);
    lap[p] = v;
    hist[Math.min(1023, Math.round(v * 4))]++;
  }
  let floor = NOISE_LEVELS[noise];
  if (floor === undefined) {
    // sensor noise is everywhere, detail is not: the median |Laplacian| is the noise (1.4826 MAD = sigma)
    let acc = 0, med = 0;
    for (let i = 0; i < 1024; i++) {
      acc += hist[i];
      if (acc >= mn / 2) {
        med = i / 4;
        break;
      }
    }
    floor = Math.min(12, 1.4826 * med * 1.5);
  }
  const f2 = floor * floor;
  for (let p = 0; p < mn; p++) lap[p] = Math.max(0, lap[p] * lap[p] - f2);
  boxMean(lap, mw, mh, Math.max(2, Math.round(Math.max(mw, mh) / 110)), lap);
  const S = reduce(img, Math.max(16, scale));
  const w = S.width, h = S.height, n = w * h;
  const e = resizePlane(lap, mw, mh, w, h);
  // log scale against the 98th percentile: a range of sharpness, not of contrast
  const sorted = Float32Array.from(e).sort();
  const ref = Math.sqrt(Math.max(sorted[Math.min(n - 1, Math.floor(n * 0.98))], 1));
  const data = new Float32Array(n), k = Math.log(1 + 40);
  for (let p = 0; p < n; p++) data[p] = clamp01(Math.log(1 + (40 * Math.sqrt(e[p])) / ref) / k);
  let lo = 1, hi = 0;
  for (let p = 0; p < n; p++) {
    if (data[p] < lo) lo = data[p];
    if (data[p] > hi) hi = data[p];
  }
  // an image without a clear split (all sharp or all blurred) keeps a mid threshold instead of cutting noise in two
  const auto = hi - lo > 0.25 ? Math.round(otsu(data, n) * 100) : 50;
  return { width: w, height: h, data, auto, S };
}

/**
 * Focus Area: the parts of the image in focus. The sharpness measure is thresholded at
 * `range` (0 selects everything, higher values only the sharpest places; autoRange picks the threshold
 * between the two populations) and a graph cut with the colour edges as smoothness term turns the
 * speckled threshold into regions; small islands and pinholes are removed.
 * @param {ImageDataLike} img
 * @param {{ range?: number, noise?: 'auto' | 'low' | 'medium' | 'high', autoRange?: boolean, measure?: object,
 *   hardEdge?: boolean, stats?: object }} [opts] measure: a focusMeasure() result to reuse (the dialog's slider)
 * @returns {Uint8ClampedArray} mask 0..255
 */
export function focusArea(img, opts = {}) {
  const W = img.width, H = img.height, out = new Uint8ClampedArray(W * H);
  if (!W || !H) return out;
  const fm = opts.measure ?? focusMeasure(img, { noise: opts.noise ?? 'auto' });
  const range = opts.autoRange || opts.range === undefined ? fm.auto : Math.max(0, Math.min(100, +opts.range || 0));
  if (opts.stats) opts.stats.range = range;
  const S = fm.S, w = S.width, h = S.height, n = w * h;
  if (range <= 0) {
    for (let p = 0, i = 3; p < out.length; p++, i += 4) out[p] = img.data[i] >= 128 ? 255 : 0;
    return out;
  }
  const t = range / 100, labels = new Uint8Array(n), prior = new Float32Array(n);
  for (let p = 0; p < n; p++) {
    const v = fm.data[p];
    labels[p] = v >= t ? GC_PR_FGD : GC_PR_BGD;
    prior[p] = 1 / (1 + Math.exp(-(v - t) / 0.06));
  }
  const bin = cutReduced(S, labels, { colorWeight: 0, prior, priorWeight: 1, lambda: 12, stats: opts.stats });
  cleanLabels(bin, w, h, { keep: 0, minArea: n * 0.002, hole: n * 0.002 });
  return finish(img, S, bin, out, opts);
}

// ---- Object Selection ------------------------------------------------------------------------------------------------

/**
 * Object Selection: the object inside a rough region. GrabCut starts with the region as probable
 * foreground and everything outside it as background, on a crop a little larger than the region (so
 * a small object is cut at full detail). When the region leaves no outside to learn the background
 * from, its rim stands in. A region whose content cannot be told from its surroundings is returned whole.
 * @param {ImageDataLike} img
 * @param {Rect | Array<[number, number]>} region rectangle or polygon (document pixels)
 * @param {{ scale?: number, hardEdge?: boolean, iterations?: number, stats?: object }} [opts]
 * @returns {Uint8ClampedArray} mask 0..255
 */
export function objectSelect(img, region, opts = {}) {
  const W = img.width, H = img.height, out = new Uint8ClampedArray(W * H);
  if (!W || !H || !region) return out;
  let inside, rb;
  if (Array.isArray(region)) {
    if (region.length < 3) return out;
    inside = rasterizePolygon(region, W, H, { antialias: false });
    let x0 = W, y0 = H, x1 = -1, y1 = -1;
    for (const [x, y] of region) {
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
    rb = clipRect({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, W, H);
  } else {
    rb = clipRect(region, W, H);
    inside = null;
  }
  if (rb.width < 2 || rb.height < 2) return out;
  const pad = Math.max(8, Math.round(0.25 * Math.max(rb.width, rb.height)));
  const crop = clipRect({ x: rb.x - pad, y: rb.y - pad, width: rb.width + 2 * pad, height: rb.height + 2 * pad }, W, H);
  const S = reduce(img, Math.max(16, opts.scale ?? 512), crop);
  const w = S.width, h = S.height, n = w * h;
  // the region on the reduced grid (a cell is inside when its centre is)
  const reg = new Float32Array(n);
  let inCount = 0;
  for (let y = 0; y < h; y++) {
    const fy = Math.min(H - 1, Math.floor(crop.y + ((y + 0.5) * crop.height) / h));
    for (let x = 0; x < w; x++) {
      const fx = Math.min(W - 1, Math.floor(crop.x + ((x + 0.5) * crop.width) / w));
      const isIn = inside ? inside[fy * W + fx] >= 128 : fx >= rb.x && fx < rb.x + rb.width && fy >= rb.y && fy < rb.y + rb.height;
      if (isIn) {
        reg[y * w + x] = 1;
        inCount++;
      }
    }
  }
  if (!inCount) return out;
  const labels = new Uint8Array(n);
  for (let p = 0; p < n; p++) labels[p] = reg[p] ? GC_PR_FGD : GC_BGD;
  if (n - inCount < Math.max(64, n * 0.08)) {
    // hardly any outside: the rim of the region is the best guess at the background
    const t = Math.max(2, Math.round(Math.min(w, h) * 0.05));
    const rim = boxMean(reg, w, h, t, new Float32Array(n));
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (reg[p] && (rim[p] < 0.999 || x < t || y < t || x >= w - t || y >= h - t)) labels[p] = GC_PR_BGD;
    }
  }
  const bin = cutReduced(S, labels, { iterations: opts.iterations ?? 5, isolate: reg, stats: opts.stats });
  let area = 0;
  for (let p = 0; p < n; p++) {
    if (!reg[p]) bin[p] = 0;
    area += bin[p];
  }
  if (area < Math.max(2, inCount * 0.004)) {
    bin.set(reg); // nothing stands out: the region itself, as drawn
  } else {
    cleanLabels(bin, w, h, { keep: 0.15, hole: area * 0.02 });
  }
  finish(img, S, bin, out, opts);
  // never beyond what was drawn
  if (inside) {
    for (let y = crop.y; y < crop.y + crop.height; y++) for (let x = crop.x; x < crop.x + crop.width; x++) if (inside[y * W + x] < 128) out[y * W + x] = 0;
  } else {
    for (let y = crop.y; y < crop.y + crop.height; y++) for (let x = crop.x; x < crop.x + crop.width; x++) if (x < rb.x || x >= rb.x + rb.width || y < rb.y || y >= rb.y + rb.height) out[y * W + x] = 0;
  }
  return out;
}
