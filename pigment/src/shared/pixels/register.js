// Image registration for Auto-Align Layers, Photomerge and Load Files into Stack, plus the seam and
// gain maths of Auto-Blend Layers (see ARCHITECTURE.md "Auto-Align, Auto-Blend, Photomerge, stacks").
//
// The pipeline is the classic feature one: FAST-9 corners on a reduced greyscale copy, an
// orientation from the intensity centroid, a 256-bit rotated BRIEF descriptor (ORB), brute-force
// Hamming matching with Lowe's ratio test and a cross check, then RANSAC for the motion model the
// projection asks for (translation, similarity, homography). alignImages() chains the pairwise
// models through the match graph to a reference image.
//
// Everything is pure: typed arrays, plain loops, deterministic (seeded sampling) and DOM-free, so
// it runs in Node unit tests. Coordinates are pixel indices (the centre of pixel (x, y) is (x, y)),
// which is what FAST reports; a model fitted on them maps pixel indices to pixel indices.
import { createImage, randomSeeded } from './core.js';
import { homography as homographyFrom4, invertHomography } from './transform.js';

// ---- greyscale helpers ----------------------------------------------------------------------------------------

/**
 * Greyscale copy of an image: { width, height, data: Uint8Array(w*h), alpha: Uint8Array | null }.
 * A greyscale object (data.length === w*h) is returned as it is. `alpha` exists only when the image has
 * transparency: corners are not taken on or next to transparent pixels (their colour is arbitrary).
 */
export function toGray(img) {
  const { width, height, data } = img;
  const n = width * height;
  if (data.length === n) return { width, height, data, alpha: img.alpha ?? null };
  const g = new Uint8Array(n);
  let alpha = null;
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    const a = data[i + 3];
    g[p] = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29 + 128) >> 8;
    if (a < 255) {
      if (!alpha) alpha = new Uint8Array(n).fill(255);
      alpha[p] = a;
      // transparent pixels carry no picture: flatten them so their hidden colour cannot make corners
      if (a < 128) g[p] = 0;
    }
  }
  return { width, height, data: g, alpha };
}

/** Area-averaged reduction of a greyscale image to w × h (both not larger than the source). */
export function shrinkGray(gray, w, h) {
  const { width: sw, height: sh, data: d } = gray;
  if (w === sw && h === sh) return gray;
  const out = new Uint8Array(w * h);
  const alpha = gray.alpha ? new Uint8Array(w * h) : null;
  const x0 = new Int32Array(w + 1), y0 = new Int32Array(h + 1);
  for (let x = 0; x <= w; x++) x0[x] = Math.min(sw, Math.floor((x * sw) / w));
  for (let y = 0; y <= h; y++) y0[y] = Math.min(sh, Math.floor((y * sh) / h));
  for (let y = 0; y < h; y++) {
    const ya = y0[y], yb = Math.max(ya + 1, y0[y + 1]);
    for (let x = 0; x < w; x++) {
      const xa = x0[x], xb = Math.max(xa + 1, x0[x + 1]);
      let sum = 0, amin = 255;
      for (let yy = ya; yy < yb; yy++) {
        let i = yy * sw + xa;
        for (let xx = xa; xx < xb; xx++, i++) {
          sum += d[i];
          if (alpha && gray.alpha[i] < amin) amin = gray.alpha[i];
        }
      }
      const o = y * w + x;
      out[o] = (sum / ((yb - ya) * (xb - xa)) + 0.5) | 0;
      if (alpha) alpha[o] = amin;
    }
  }
  return { width: w, height: h, data: out, alpha };
}

/** Binomial 5-tap blur applied twice (σ ≈ 1.4): BRIEF compares smoothed intensities, never single noisy pixels. */
export function smoothGray(gray) {
  const { width: w, height: h } = gray;
  let src = gray.data;
  const tmp = new Float32Array(w * h);
  for (let pass = 0; pass < 2; pass++) {
    const dst = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        const xm2 = x < 2 ? 0 : x - 2, xm1 = x < 1 ? 0 : x - 1, xp1 = x + 1 >= w ? w - 1 : x + 1, xp2 = x + 2 >= w ? w - 1 : x + 2;
        tmp[row + x] = src[row + xm2] + 4 * src[row + xm1] + 6 * src[row + x] + 4 * src[row + xp1] + src[row + xp2];
      }
    }
    for (let y = 0; y < h; y++) {
      const ym2 = (y < 2 ? 0 : y - 2) * w, ym1 = (y < 1 ? 0 : y - 1) * w, yp1 = (y + 1 >= h ? h - 1 : y + 1) * w, yp2 = (y + 2 >= h ? h - 1 : y + 2) * w, row = y * w;
      for (let x = 0; x < w; x++) dst[row + x] = ((tmp[ym2 + x] + 4 * tmp[ym1 + x] + 6 * tmp[row + x] + 4 * tmp[yp1 + x] + tmp[yp2 + x]) / 256 + 0.5) | 0;
    }
    src = dst;
  }
  return { width: w, height: h, data: src, alpha: gray.alpha ?? null };
}

// ---- FAST ----------------------------------------------------------------------------------------------------

/** The 16 pixels of the radius-3 Bresenham circle, clockwise from the top. */
const RING = [[0, -3], [1, -3], [2, -2], [3, -1], [3, 0], [3, 1], [2, 2], [1, 3], [0, 3], [-1, 3], [-2, 2], [-3, 1], [-3, 0], [-3, -1], [-2, -2], [-1, -3]];

/** True when a 16-bit ring mask holds 9 contiguous set bits (the circle wraps around). */
function hasArc9(mask) {
  const m = (mask | (mask << 16)) >>> 0;
  let x = m;
  for (let k = 1; k < 9 && x; k++) x &= m >>> k;
  return x !== 0;
}

/**
 * FAST-9 corner detector (Rosten & Drummond): a pixel is a corner when 9 contiguous pixels of the 16-pixel
 * circle around it are all brighter than it by more than `threshold`, or all darker. Returns
 * [{ x, y, score }] in scan order; the score is the summed contrast of the arc's side beyond the threshold.
 * `nonmax` keeps only local maxima of the score in a 3 × 3 neighbourhood. Note what FAST is not: the X
 * junction of a checkerboard (two bright and two dark quarter arcs) is not a FAST corner.
 */
export function fastCorners(grayIn, { threshold = 20, nonmax = true, border = 3 } = {}) {
  const gray = toGray(grayIn);
  const { width: w, height: h, data: d, alpha } = gray;
  const b = Math.max(3, border | 0);
  if (w <= b * 2 || h <= b * 2) return [];
  const off = RING.map(([dx, dy]) => dy * w + dx);
  const t = Math.max(1, threshold);
  const scoreMap = nonmax ? new Int32Array(w * h) : null;
  const xs = [], ys = [], ss = [];
  for (let y = b; y < h - b; y++) {
    let i = y * w + b;
    for (let x = b; x < w - b; x++, i++) {
      const p = d[i], hi = p + t, lo = p - t;
      // any arc of 9 covers the top or the bottom pixel, and the left or the right one: two cheap rejections
      let v = d[i + off[0]];
      let u = d[i + off[8]];
      if (!(v > hi || v < lo || u > hi || u < lo)) continue;
      v = d[i + off[4]];
      u = d[i + off[12]];
      if (!(v > hi || v < lo || u > hi || u < lo)) continue;
      let bright = 0, dark = 0, sb = 0, sd = 0;
      for (let k = 0; k < 16; k++) {
        const q = d[i + off[k]];
        if (q > hi) {
          bright |= 1 << k;
          sb += q - hi;
        } else if (q < lo) {
          dark |= 1 << k;
          sd += lo - q;
        }
      }
      let score = 0;
      if (hasArc9(bright)) score = sb;
      if (hasArc9(dark) && sd > score) score = sd;
      if (!score) continue;
      if (alpha && alpha[i] < 255) continue;
      if (scoreMap) scoreMap[i] = score;
      xs.push(x);
      ys.push(y);
      ss.push(score);
    }
  }
  const out = [];
  for (let k = 0; k < xs.length; k++) {
    const x = xs[k], y = ys[k], s = ss[k];
    if (scoreMap) {
      const i = y * w + x;
      // strict against the neighbours scanned earlier so that a plateau keeps exactly one corner
      if (scoreMap[i - w - 1] >= s || scoreMap[i - w] >= s || scoreMap[i - w + 1] >= s || scoreMap[i - 1] >= s) continue;
      if (scoreMap[i + 1] > s || scoreMap[i + w - 1] > s || scoreMap[i + w] > s || scoreMap[i + w + 1] > s) continue;
    }
    out.push({ x, y, score: s });
  }
  return out;
}

// ---- ORB (oriented FAST, rotated BRIEF) -------------------------------------------------------------------------

const PATCH_RADIUS = 15; // intensity-centroid patch (31 × 31, circular)
const PATTERN_RADIUS = 13; // BRIEF test points stay inside this circle so every rotation fits the patch
export const ORB_BORDER = 16; // corners nearer to the edge than this get no descriptor
const ANGLE_BINS = 30; // the pattern is pre-rotated in 12° steps, as in ORB
const WORDS = 8; // 256 bits

/** Half-widths of the rows of the circular orientation patch. */
const UMAX = (() => {
  const u = new Int32Array(PATCH_RADIUS + 1);
  for (let v = 0; v <= PATCH_RADIUS; v++) u[v] = Math.floor(Math.sqrt(PATCH_RADIUS * PATCH_RADIUS - v * v));
  return u;
})();

/** 256 point pairs drawn once from a Gaussian around the patch centre (deterministic). */
const PATTERN = (() => {
  const rnd = randomSeeded(0x0bb5eed);
  const gauss = () => {
    let u = 0;
    while (u < 1e-9) u = rnd();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd());
  };
  const point = () => {
    for (;;) {
      const x = Math.round(gauss() * 5.5), y = Math.round(gauss() * 5.5);
      if (x * x + y * y <= PATTERN_RADIUS * PATTERN_RADIUS) return [x, y];
    }
  };
  const p = new Int8Array(256 * 4);
  for (let k = 0; k < 256; k++) {
    const a = point();
    let c = point();
    while (a[0] === c[0] && a[1] === c[1]) c = point();
    p[k * 4] = a[0];
    p[k * 4 + 1] = a[1];
    p[k * 4 + 2] = c[0];
    p[k * 4 + 3] = c[1];
  }
  return p;
})();

/** Pixel offsets of the pattern for an image width, per rotation bin (bin 0 = unrotated). */
function patternOffsets(w, bin) {
  const a = (bin * 2 * Math.PI) / ANGLE_BINS;
  const cos = Math.cos(a), sin = Math.sin(a);
  const off = new Int32Array(512);
  for (let k = 0; k < 512; k++) {
    const x = PATTERN[k * 2], y = PATTERN[k * 2 + 1];
    off[k] = Math.round(x * sin + y * cos) * w + Math.round(x * cos - y * sin);
  }
  return off;
}

/** Orientation of the patch around (x, y): the angle of its intensity centroid (radians). */
function patchAngle(d, w, x, y) {
  let m01 = 0, m10 = 0;
  const c = y * w + x;
  for (let u = -PATCH_RADIUS; u <= PATCH_RADIUS; u++) m10 += u * d[c + u];
  for (let v = 1; v <= PATCH_RADIUS; v++) {
    let sum = 0;
    const r = UMAX[v];
    for (let u = -r; u <= r; u++) {
      const below = d[c + v * w + u], above = d[c - v * w + u];
      sum += below - above;
      m10 += u * (below + above);
    }
    m01 += v * sum;
  }
  return Math.atan2(m01, m10);
}

/**
 * Rotated BRIEF descriptors for corners: { keypoints: [{ x, y, score, angle }], descriptors: Uint32Array(8 per
 * keypoint), count }. Corners closer than ORB_BORDER to the edge (or on the rim of transparency) are dropped,
 * so `keypoints` can be shorter than `corners`. `rotate: false` gives plain upright BRIEF.
 */
export function orbDescriptors(grayIn, corners, { rotate = true, smoothed = false } = {}) {
  const gray = toGray(grayIn);
  const img = smoothed ? gray : smoothGray(gray);
  const { width: w, height: h, data: d } = img;
  const alpha = gray.alpha;
  const offsets = new Array(ANGLE_BINS).fill(null);
  const keypoints = [];
  const words = [];
  for (const c of corners) {
    const x = Math.round(c.x), y = Math.round(c.y);
    if (x < ORB_BORDER || y < ORB_BORDER || x >= w - ORB_BORDER || y >= h - ORB_BORDER) continue;
    const i = y * w + x;
    if (alpha) {
      // the patch must not reach into transparency: eight probes on a radius-10 circle are a cheap test of that
      if (alpha[i - 10] < 255 || alpha[i + 10] < 255 || alpha[i - 10 * w] < 255 || alpha[i + 10 * w] < 255) continue;
      if (alpha[i - 7 * w - 7] < 255 || alpha[i - 7 * w + 7] < 255 || alpha[i + 7 * w - 7] < 255 || alpha[i + 7 * w + 7] < 255) continue;
    }
    const angle = rotate ? patchAngle(d, w, x, y) : 0;
    let bin = rotate ? Math.round((angle / (2 * Math.PI)) * ANGLE_BINS) % ANGLE_BINS : 0;
    if (bin < 0) bin += ANGLE_BINS;
    const off = offsets[bin] ?? (offsets[bin] = patternOffsets(w, bin));
    for (let wd = 0; wd < WORDS; wd++) {
      let bits = 0;
      const base = wd * 64;
      for (let k = 0; k < 32; k++) if (d[i + off[base + k * 2]] < d[i + off[base + k * 2 + 1]]) bits |= 1 << k;
      words.push(bits >>> 0);
    }
    keypoints.push({ x: c.x, y: c.y, score: c.score ?? 0, angle });
  }
  return { keypoints, descriptors: Uint32Array.from(words), count: keypoints.length };
}

/** Upright BRIEF (no orientation): enough for images that are only shifted. */
export const briefDescriptors = (gray, corners, opts = {}) => orbDescriptors(gray, corners, { ...opts, rotate: false });

/**
 * Detects and describes features of an image on a small pyramid of a reduced copy (the longest side is brought
 * down to `maxSize`; `levels` further steps of 1/`scaleFactor` give some scale tolerance). Keypoints are returned
 * in the coordinates of the full image: { keypoints: [{ x, y, score, angle, level }], descriptors, count, scale }.
 * The strongest corners are kept with a per-cell cap so they spread over the picture instead of crowding one
 * busy area.
 */
export function detectFeatures(img, { maxSize = 1000, maxFeatures = 1500, levels = 3, scaleFactor = 1.3, threshold = 20, rotate = true } = {}) {
  const full = toGray(img);
  const scale = Math.min(1, maxSize / Math.max(full.width, full.height));
  const keypoints = [];
  const parts = [];
  let total = 0;
  for (let level = 0; level < Math.max(1, levels); level++) {
    const s = scale / Math.pow(scaleFactor, level);
    const w = Math.max(1, Math.round(full.width * s)), h = Math.max(1, Math.round(full.height * s));
    if (Math.min(w, h) < ORB_BORDER * 2 + 8) break;
    const gray = shrinkGray(full, w, h);
    const quota = Math.max(50, Math.round(maxFeatures / Math.pow(scaleFactor, level * 1.5)));
    // flat or soft pictures have few strong corners: lower the bar until there is enough to match
    let corners = [];
    for (let t = threshold; ; t = Math.floor(t / 2)) {
      corners = fastCorners(gray, { threshold: t, nonmax: true, border: ORB_BORDER });
      if (corners.length >= quota / 3 || t <= 5) break;
    }
    corners = spreadCorners(corners, w, h, quota);
    const f = orbDescriptors(gray, corners, { rotate });
    const kx = full.width / w, ky = full.height / h;
    for (const k of f.keypoints) keypoints.push({ x: (k.x + 0.5) * kx - 0.5, y: (k.y + 0.5) * ky - 0.5, score: k.score, angle: k.angle, level });
    parts.push(f.descriptors);
    total += f.count;
  }
  const descriptors = new Uint32Array(total * WORDS);
  let o = 0;
  for (const p of parts) {
    descriptors.set(p, o);
    o += p.length;
  }
  return { keypoints, descriptors, count: total, scale, width: full.width, height: full.height };
}

/** The strongest `max` corners, at most a fair share per cell of a 8 × 8 grid first, the rest by score. */
function spreadCorners(corners, w, h, max) {
  if (corners.length <= max) return corners;
  const sorted = corners.slice().sort((a, b) => b.score - a.score);
  const G = 8;
  const cap = Math.max(4, Math.ceil((max / (G * G)) * 2));
  const counts = new Int32Array(G * G);
  const kept = [], spare = [];
  for (const c of sorted) {
    const cell = Math.min(G - 1, Math.floor((c.y * G) / h)) * G + Math.min(G - 1, Math.floor((c.x * G) / w));
    if (counts[cell] < cap && kept.length < max) {
      counts[cell]++;
      kept.push(c);
    } else spare.push(c);
  }
  for (let i = 0; kept.length < max && i < spare.length; i++) kept.push(spare[i]);
  return kept;
}

// ---- matching ----------------------------------------------------------------------------------------------------

function popcount(x) {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  x = (x + (x >>> 4)) & 0x0f0f0f0f;
  return Math.imul(x, 0x01010101) >>> 24;
}

const descriptorsOf = (f) => (f instanceof Uint32Array ? f : f.descriptors);

/**
 * Brute-force Hamming matching of two descriptor sets (Uint32Array with 8 words per feature, or the objects
 * orbDescriptors / detectFeatures return). A match survives Lowe's ratio test (best < ratio × second best),
 * the cross check (each is the other's nearest) and `maxDistance`. Returns [{ a, b, distance }].
 */
export function matchDescriptors(fa, fb, { ratio = 0.8, crossCheck = true, maxDistance = 80 } = {}) {
  const A = descriptorsOf(fa), B = descriptorsOf(fb);
  const na = (A.length / WORDS) | 0, nb = (B.length / WORDS) | 0;
  if (!na || !nb) return [];
  const bestA = new Int32Array(na).fill(-1), distA = new Int32Array(na), secondA = new Int32Array(na);
  for (let i = 0; i < na; i++) {
    const o = i * WORDS;
    const a0 = A[o], a1 = A[o + 1], a2 = A[o + 2], a3 = A[o + 3], a4 = A[o + 4], a5 = A[o + 5], a6 = A[o + 6], a7 = A[o + 7];
    let best = 1 << 30, second = 1 << 30, bj = -1;
    for (let j = 0, q = 0; j < nb; j++, q += WORDS) {
      let dist = popcount(a0 ^ B[q]) + popcount(a1 ^ B[q + 1]) + popcount(a2 ^ B[q + 2]) + popcount(a3 ^ B[q + 3]);
      if (dist < second) dist += popcount(a4 ^ B[q + 4]) + popcount(a5 ^ B[q + 5]) + popcount(a6 ^ B[q + 6]) + popcount(a7 ^ B[q + 7]);
      else continue; // already no better than the second best: the remaining words can only add
      if (dist < best) {
        second = best;
        best = dist;
        bj = j;
      } else if (dist < second) second = dist;
    }
    bestA[i] = bj;
    distA[i] = best;
    secondA[i] = second;
  }
  // the cross check (is a also b's nearest?) is verified only for the candidates that survived the ratio test
  const out = [];
  for (let i = 0; i < na; i++) {
    const j = bestA[i];
    if (j < 0 || distA[i] > maxDistance) continue;
    if (nb > 1 && distA[i] >= ratio * secondA[i]) continue;
    if (crossCheck && !isNearestInA(A, B, na, j, i, distA[i])) continue;
    out.push({ a: i, b: j, distance: distA[i] });
  }
  return out;
}

/** True when no feature of A other than i is closer to B[j] than `dist`. */
function isNearestInA(A, B, na, j, i, dist) {
  const q = j * WORDS;
  for (let k = 0, o = 0; k < na; k++, o += WORDS) {
    if (k === i) continue;
    let d = 0;
    for (let wd = 0; wd < WORDS && d < dist; wd++) d += popcount(A[o + wd] ^ B[q + wd]);
    if (d < dist) return false;
  }
  return true;
}

/** Point pairs of a match list: [{ x1, y1, x2, y2 }] (1 = the first image, 2 = the second). */
export function matchedPoints(fa, fb, matches) {
  return matches.map((m) => {
    const p = fa.keypoints[m.a], q = fb.keypoints[m.b];
    return { x1: p.x, y1: p.y, x2: q.x, y2: q.y };
  });
}

// ---- small linear algebra -------------------------------------------------------------------------------------

/** Solves A x = b in place (Gaussian elimination with partial pivoting); null when singular. */
function solveLinear(A, b) {
  const n = b.length;
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    if (Math.abs(A[piv][col]) < 1e-12) return null;
    if (piv !== col) {
      [A[col], A[piv]] = [A[piv], A[col]];
      [b[col], b[piv]] = [b[piv], b[col]];
    }
    for (let r = col + 1; r < n; r++) {
      const f = A[r][col] / A[col][col];
      if (!f) continue;
      for (let c = col; c < n; c++) A[r][c] -= f * A[col][c];
      b[r] -= f * b[col];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let c = r + 1; c < n; c++) s -= A[r][c] * x[c];
    x[r] = s / A[r][r];
  }
  return x;
}

export const IDENTITY3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/** 3 × 3 product A·B (row-major): apply B first, then A. */
export function multiply3(A, B) {
  const o = new Array(9);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) o[r * 3 + c] = A[r * 3] * B[c] + A[r * 3 + 1] * B[3 + c] + A[r * 3 + 2] * B[6 + c];
  return o;
}

/** Scales a homography so its last element is 1 (when it can be). */
function normalise3(H) {
  const k = H[8];
  return Math.abs(k) > 1e-12 ? H.map((v) => v / k) : H.slice();
}

/** Inverse of a 3 × 3 homography, normalised; null when singular. */
export function invert3(H) {
  try {
    const inv = invertHomography(H);
    return inv.every(Number.isFinite) ? normalise3(inv) : null;
  } catch {
    return null;
  }
}

/** Applies a homography to a point: [x', y'] (Infinity when the point maps to the horizon). */
export function applyH(H, x, y) {
  const w = H[6] * x + H[7] * y + H[8];
  return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
}

/** Affine matrix [a, b, c, d, e, f] (Canvas order) as a homography, and back (only valid when H is affine). */
export const matrixToH = (m) => [m[0], m[2], m[4], m[1], m[3], m[5], 0, 0, 1];
export const hToMatrix = (H) => [H[0] / H[8], H[3] / H[8], H[1] / H[8], H[4] / H[8], H[2] / H[8], H[5] / H[8]];

// ---- model fitting -------------------------------------------------------------------------------------------

/** Least-squares homography through point pairs (normalised DLT with h8 = 1 in the normalised frame). */
export function fitHomography(pairs, idx = null) {
  const n = idx ? idx.length : pairs.length;
  if (n < 4) return null;
  const at = (k) => pairs[idx ? idx[k] : k];
  // Hartley normalisation: both point sets centred with a mean distance of √2 keeps the normal equations well conditioned
  let mx1 = 0, my1 = 0, mx2 = 0, my2 = 0;
  for (let k = 0; k < n; k++) {
    const p = at(k);
    mx1 += p.x1;
    my1 += p.y1;
    mx2 += p.x2;
    my2 += p.y2;
  }
  mx1 /= n;
  my1 /= n;
  mx2 /= n;
  my2 /= n;
  let d1 = 0, d2 = 0;
  for (let k = 0; k < n; k++) {
    const p = at(k);
    d1 += Math.hypot(p.x1 - mx1, p.y1 - my1);
    d2 += Math.hypot(p.x2 - mx2, p.y2 - my2);
  }
  if (d1 < 1e-9 || d2 < 1e-9) return null;
  const s1 = (Math.SQRT2 * n) / d1, s2 = (Math.SQRT2 * n) / d2;
  const A = Array.from({ length: 8 }, () => new Array(8).fill(0));
  const b = new Array(8).fill(0);
  const row = new Array(8);
  const add = (rhs) => {
    for (let i = 0; i < 8; i++) {
      if (!row[i]) continue;
      for (let j = i; j < 8; j++) A[i][j] += row[i] * row[j];
      b[i] += row[i] * rhs;
    }
  };
  for (let k = 0; k < n; k++) {
    const p = at(k);
    const x = (p.x1 - mx1) * s1, y = (p.y1 - my1) * s1, u = (p.x2 - mx2) * s2, v = (p.y2 - my2) * s2;
    row[0] = x; row[1] = y; row[2] = 1; row[3] = 0; row[4] = 0; row[5] = 0; row[6] = -u * x; row[7] = -u * y;
    add(u);
    row[0] = 0; row[1] = 0; row[2] = 0; row[3] = x; row[4] = y; row[5] = 1; row[6] = -v * x; row[7] = -v * y;
    add(v);
  }
  for (let i = 0; i < 8; i++) for (let j = 0; j < i; j++) A[i][j] = A[j][i];
  const hv = solveLinear(A, b);
  if (!hv) return null;
  const Hn = [hv[0], hv[1], hv[2], hv[3], hv[4], hv[5], hv[6], hv[7], 1];
  // H = T2⁻¹ · Hn · T1
  const T1 = [s1, 0, -mx1 * s1, 0, s1, -my1 * s1, 0, 0, 1];
  const T2inv = [1 / s2, 0, mx2, 0, 1 / s2, my2, 0, 0, 1];
  const H = multiply3(T2inv, multiply3(Hn, T1));
  return Math.abs(H[8]) > 1e-12 && H.every(Number.isFinite) ? normalise3(H) : null;
}

/** Least-squares affine matrix [a, b, c, d, e, f] through point pairs. */
export function fitAffine(pairs, idx = null) {
  const n = idx ? idx.length : pairs.length;
  if (n < 3) return null;
  let sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0, su = 0, sv = 0, sxu = 0, syu = 0, sxv = 0, syv = 0;
  for (let k = 0; k < n; k++) {
    const p = pairs[idx ? idx[k] : k];
    sx += p.x1; sy += p.y1; sxx += p.x1 * p.x1; sxy += p.x1 * p.y1; syy += p.y1 * p.y1;
    su += p.x2; sv += p.y2; sxu += p.x1 * p.x2; syu += p.y1 * p.x2; sxv += p.x1 * p.y2; syv += p.y1 * p.y2;
  }
  const N = () => [[sxx, sxy, sx], [sxy, syy, sy], [sx, sy, n]];
  const u = solveLinear(N(), [sxu, syu, su]);
  const v = solveLinear(N(), [sxv, syv, sv]);
  if (!u || !v) return null;
  return [u[0], v[0], u[1], v[1], u[2], v[2]];
}

/** Least-squares similarity (rotation, uniform scale, translation; no mirror) through point pairs. */
export function fitSimilarity(pairs, idx = null) {
  const n = idx ? idx.length : pairs.length;
  if (n < 2) return null;
  let mx1 = 0, my1 = 0, mx2 = 0, my2 = 0;
  for (let k = 0; k < n; k++) {
    const p = pairs[idx ? idx[k] : k];
    mx1 += p.x1; my1 += p.y1; mx2 += p.x2; my2 += p.y2;
  }
  mx1 /= n; my1 /= n; mx2 /= n; my2 /= n;
  let dot = 0, cross = 0, norm = 0;
  for (let k = 0; k < n; k++) {
    const p = pairs[idx ? idx[k] : k];
    const x = p.x1 - mx1, y = p.y1 - my1, u = p.x2 - mx2, v = p.y2 - my2;
    dot += x * u + y * v;
    cross += x * v - y * u;
    norm += x * x + y * y;
  }
  if (norm < 1e-9) return null;
  const a = dot / norm, b = cross / norm;
  return [a, b, -b, a, mx2 - (a * mx1 - b * my1), my2 - (b * mx1 + a * my1)];
}

/** Distinct random indices below n. */
function sample(rnd, n, k, out) {
  for (let i = 0; i < k; i++) {
    let v;
    let again = true;
    while (again) {
      v = Math.floor(rnd() * n);
      again = false;
      for (let j = 0; j < i; j++) if (out[j] === v) again = true;
    }
    out[i] = v;
  }
  return out;
}

/** RANSAC iterations still needed for `confidence` given the best inlier ratio seen so far. */
function iterationsFor(inlierRatio, sampleSize, confidence, max) {
  const p = Math.pow(inlierRatio, sampleSize);
  if (p <= 1e-9) return max;
  if (p >= 1 - 1e-9) return 1;
  return Math.min(max, Math.ceil(Math.log(1 - confidence) / Math.log(1 - p)));
}

/** Shared RANSAC loop: fit(sampleIndices) -> model | null, error(model, pair) -> squared distance. */
function ransac(pairs, { size, fit, refit, error, threshold, iterations, seed, confidence = 0.995 }) {
  const n = pairs.length;
  if (n < size) return { model: null, inliers: [] };
  const rnd = randomSeeded(seed);
  const t2 = threshold * threshold;
  const pick = new Array(size);
  let best = null, bestCount = 0, bestErr = Infinity;
  let needed = iterations;
  const exhaustive = size === 1 && n <= iterations; // a one-point model: simply try every pair
  for (let it = 0; it < (exhaustive ? n : needed); it++) {
    if (exhaustive) pick[0] = it;
    else sample(rnd, n, size, pick);
    const model = fit(pick);
    if (!model) continue;
    let count = 0, err = 0;
    for (let k = 0; k < n; k++) {
      const e = error(model, pairs[k]);
      if (e <= t2) {
        count++;
        err += e;
      }
    }
    if (count > bestCount || (count === bestCount && err < bestErr)) {
      best = model;
      bestCount = count;
      bestErr = err;
      if (!exhaustive) needed = Math.min(needed, Math.max(it + 1, iterationsFor(count / n, size, confidence, iterations)));
    }
  }
  if (!best || bestCount < size) return { model: null, inliers: [] };
  // least squares on the consensus set, twice: the refit can pull a few more pairs inside the threshold
  let model = best;
  let inliers = [];
  for (let round = 0; round < 3; round++) {
    inliers = [];
    for (let k = 0; k < n; k++) if (error(model, pairs[k]) <= t2) inliers.push(k);
    if (inliers.length < size) break;
    const next = refit(inliers);
    if (!next) break;
    model = next;
  }
  inliers = [];
  for (let k = 0; k < n; k++) if (error(model, pairs[k]) <= t2) inliers.push(k);
  return { model, inliers };
}

const errH = (H, p) => {
  const w = H[6] * p.x1 + H[7] * p.y1 + H[8];
  if (w <= 1e-9) return Infinity;
  const dx = (H[0] * p.x1 + H[1] * p.y1 + H[2]) / w - p.x2, dy = (H[3] * p.x1 + H[4] * p.y1 + H[5]) / w - p.y2;
  return dx * dx + dy * dy;
};
const errM = (m, p) => {
  const dx = m[0] * p.x1 + m[2] * p.y1 + m[4] - p.x2, dy = m[1] * p.x1 + m[3] * p.y1 + m[5] - p.y2;
  return dx * dx + dy * dy;
};

/**
 * Homography (x1, y1) -> (x2, y2) from point pairs with outliers: { H: number[9] | null (row-major, H[8] = 1),
 * inliers: indices into `pairs` }. `threshold` is the reprojection error in pixels that still counts as an inlier.
 */
export function ransacHomography(pairs, { threshold = 3, iterations = 2000, seed = 1 } = {}) {
  const r = ransac(pairs, {
    size: 4,
    threshold,
    iterations,
    seed,
    error: errH,
    fit: (s) => {
      try {
        const H = homographyFrom4(s.map((k) => [pairs[k].x1, pairs[k].y1]), s.map((k) => [pairs[k].x2, pairs[k].y2]));
        return H.every(Number.isFinite) ? H : null;
      } catch {
        return null; // three of the four points in a line
      }
    },
    refit: (idx) => fitHomography(pairs, idx),
  });
  return { H: r.model, inliers: r.inliers };
}

/** Affine model from point pairs with outliers: { matrix: [a, b, c, d, e, f] | null, inliers }. */
export function ransacAffine(pairs, { threshold = 3, iterations = 1000, seed = 1 } = {}) {
  const r = ransac(pairs, { size: 3, threshold, iterations, seed, error: errM, fit: (s) => fitAffine(pairs, s), refit: (idx) => fitAffine(pairs, idx) });
  return { matrix: r.model, inliers: r.inliers };
}

/** Similarity (rotate, scale, move) from point pairs with outliers: { matrix | null, inliers }. */
export function ransacSimilarity(pairs, { threshold = 3, iterations = 1000, seed = 1 } = {}) {
  const r = ransac(pairs, { size: 2, threshold, iterations, seed, error: errM, fit: (s) => fitSimilarity(pairs, s), refit: (idx) => fitSimilarity(pairs, idx) });
  return { matrix: r.model, inliers: r.inliers };
}

/** Pure shift from point pairs with outliers: { dx, dy, matrix | null, inliers } (x2 = x1 + dx). */
export function ransacTranslation(pairs, { threshold = 3, iterations = 1000, seed = 1 } = {}) {
  const mean = (idx) => {
    let dx = 0, dy = 0;
    for (const k of idx) {
      dx += pairs[k].x2 - pairs[k].x1;
      dy += pairs[k].y2 - pairs[k].y1;
    }
    return [1, 0, 0, 1, dx / idx.length, dy / idx.length];
  };
  const r = ransac(pairs, { size: 1, threshold, iterations, seed, error: errM, fit: mean, refit: mean });
  return { dx: r.model ? r.model[4] : 0, dy: r.model ? r.model[5] : 0, matrix: r.model, inliers: r.inliers };
}

// ---- cylindrical and spherical projection ------------------------------------------------------------------------

/**
 * Focal length (pixels) of the camera from the homography between two views that differ by a rotation
 * (Szeliski & Shum; the same closed form OpenCV's stitcher uses). H must map coordinates centred on the first
 * image's centre to coordinates centred on the second's. null when the homography does not constrain it.
 */
export function focalFromHomography(H) {
  const h = normalise3(H);
  // each focal has two closed forms v = numerator / d; the better conditioned one (larger |d|) that is positive wins
  const pick = (n1, d1, n2, d2) => {
    const scale = Math.max(Math.abs(d1), Math.abs(d2));
    if (scale < 1e-18) return null;
    const c = [[n1 / d1, Math.abs(d1)], [n2 / d2, Math.abs(d2)]].filter(([v, d]) => d > scale * 1e-6 && Number.isFinite(v) && v > 0);
    if (!c.length) return null;
    c.sort((p, q) => q[1] - p[1]);
    return Math.sqrt(c[0][0]);
  };
  const f1 = pick(-(h[0] * h[1] + h[3] * h[4]), h[6] * h[7], h[0] * h[0] + h[3] * h[3] - h[1] * h[1] - h[4] * h[4], (h[7] - h[6]) * (h[7] + h[6]));
  const f0 = pick(-h[2] * h[5], h[0] * h[3] + h[1] * h[4], h[5] * h[5] - h[2] * h[2], h[0] * h[0] + h[1] * h[1] - h[3] * h[3] - h[4] * h[4]);
  if (f0 && f1) return Math.sqrt(f0 * f1);
  return f0 ?? f1 ?? null;
}

/** Image point (x, y) -> coordinates on the cylinder / sphere of radius `focal`, relative to the image centre. */
export function projectPoint(type, focal, cx, cy, x, y) {
  const dx = x - cx, dy = y - cy;
  const theta = Math.atan2(dx, focal);
  const hyp = Math.hypot(dx, focal);
  return [focal * theta, type === 'spherical' ? focal * Math.atan2(dy, hyp) : (focal * dy) / hyp];
}

/** Inverse of projectPoint. */
export function unprojectPoint(type, focal, cx, cy, u, v) {
  const theta = u / focal;
  const dx = focal * Math.tan(theta);
  const hyp = focal / Math.cos(theta);
  return [cx + dx, cy + (type === 'spherical' ? Math.tan(v / focal) * hyp : (v * hyp) / focal)];
}

/** Bounds (floats) of an image of w × h warped onto the cylinder / sphere, relative to its centre. */
function projectedBounds(type, focal, w, h) {
  const cx = (w - 1) / 2, cy = (h - 1) / 2;
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  const visit = (x, y) => {
    const [u, v] = projectPoint(type, focal, cx, cy, x, y);
    if (u < x1) x1 = u;
    if (u > x2) x2 = u;
    if (v < y1) y1 = v;
    if (v > y2) y2 = v;
  };
  const steps = 32;
  for (let k = 0; k <= steps; k++) {
    const x = ((w - 1) * k) / steps, y = ((h - 1) * k) / steps;
    visit(x, 0);
    visit(x, h - 1);
    visit(0, y);
    visit(w - 1, y);
  }
  return { x1, y1, x2, y2 };
}

/**
 * Warps an image onto a cylinder or a sphere of radius `focal` (pixels). Returns { image, x, y }: the warped
 * pixels and the position of their top-left pixel relative to the image centre (integers), so that a
 * translation found between warped images places them. Bilinear, premultiplied, transparent outside.
 */
export function warpProjection(img, { type = 'cylindrical', focal }) {
  const { width: w, height: h, data: d } = img;
  const cx = (w - 1) / 2, cy = (h - 1) / 2;
  const b = projectedBounds(type, focal, w, h);
  const ox = Math.floor(b.x1), oy = Math.floor(b.y1);
  const ow = Math.max(1, Math.ceil(b.x2) - ox + 1), oh = Math.max(1, Math.ceil(b.y2) - oy + 1);
  const out = createImage(ow, oh);
  const od = out.data;
  const spherical = type === 'spherical';
  for (let x = 0; x < ow; x++) {
    const theta = (x + ox) / focal;
    if (Math.abs(theta) >= Math.PI / 2 - 1e-3) continue;
    const sx = cx + focal * Math.tan(theta);
    if (sx <= -1 || sx >= w) continue;
    const hyp = focal / Math.cos(theta);
    const x0 = Math.floor(sx), tx = sx - x0;
    for (let y = 0; y < oh; y++) {
      const v = y + oy;
      const sy = cy + (spherical ? Math.tan(v / focal) * hyp : (v * hyp) / focal);
      if (sy <= -1 || sy >= h) continue;
      const y0 = Math.floor(sy), ty = sy - y0;
      let r = 0, g = 0, bl = 0, a = 0;
      for (let j = 0; j < 2; j++) {
        const yy = y0 + j;
        if (yy < 0 || yy >= h) continue;
        const wy = j ? ty : 1 - ty;
        for (let i = 0; i < 2; i++) {
          const xx = x0 + i;
          if (xx < 0 || xx >= w) continue;
          const wgt = wy * (i ? tx : 1 - tx);
          if (!wgt) continue;
          const p = (yy * w + xx) * 4;
          const pa = d[p + 3] * wgt;
          r += d[p] * pa;
          g += d[p + 1] * pa;
          bl += d[p + 2] * pa;
          a += pa;
        }
      }
      if (a < 0.5) continue;
      const o = (y * ow + x) * 4;
      od[o] = r / a;
      od[o + 1] = g / a;
      od[o + 2] = bl / a;
      od[o + 3] = a;
    }
  }
  return { image: out, x: ox, y: oy };
}

// ---- alignImages ------------------------------------------------------------------------------------------------

export const PROJECTIONS = ['auto', 'perspective', 'collage', 'cylindrical', 'spherical', 'reposition'];

/** Bounds { x, y, width, height } (integers) of an image of w × h under a homography; null when a corner is behind the camera. */
function boundsUnderH(H, w, h) {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const [x, y] of [[-0.5, -0.5], [w - 0.5, -0.5], [w - 0.5, h - 0.5], [-0.5, h - 0.5]]) {
    const ww = H[6] * x + H[7] * y + H[8];
    if (ww <= 1e-6) return null;
    const u = (H[0] * x + H[1] * y + H[2]) / ww, v = (H[3] * x + H[4] * y + H[5]) / ww;
    if (!Number.isFinite(u) || !Number.isFinite(v)) return null;
    if (u < x1) x1 = u;
    if (u > x2) x2 = u;
    if (v < y1) y1 = v;
    if (v > y2) y2 = v;
  }
  const x = Math.floor(x1 + 0.5 + 1e-6), y = Math.floor(y1 + 0.5 + 1e-6);
  return { x, y, width: Math.max(1, Math.ceil(x2 + 0.5 - 1e-6) - x), height: Math.max(1, Math.ceil(y2 + 0.5 - 1e-6) - y) };
}

const unionBounds = (a, b) => {
  if (!a) return b ? { ...b } : null;
  if (!b) return { ...a };
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
};

/** Fewest inliers a pairwise model needs before two images count as overlapping. */
const MIN_INLIERS = { translation: 6, similarity: 7, homography: 10 };

/**
 * Registers images against a reference. `images` are ImageDataLike (or feature sets from detectFeatures with
 * `width`/`height`). Options: projection ('auto' | 'perspective' | 'collage' | 'cylindrical' | 'spherical' |
 * 'reposition'), reference (index; default: the image in the middle of the match graph, ties to the middle of
 * the list), maxSize / maxFeatures (feature detection), focal (pixels, overrides the estimate), seed.
 *
 * Returns an array with one entry per image:
 *   { index, matched, homography: number[9], matrix: [a, b, c, d, e, f] | null, warp: { type, focal } | null,
 *     bounds: { x, y, width, height }, parent, inliers }
 * in the pixel space of the reference image (its top-left pixel is (0, 0)). `matrix` is set when the model is
 * affine (reposition, collage and the translations of the cylindrical / spherical layouts); with `warp` the
 * image is first warped by warpProjection() and its result is placed at bounds.x / bounds.y. An image that
 * could not be connected to the reference has matched: false and stays where it is. The array also carries
 * `projection` (the one used: 'auto' resolves to one of the others), `reference`, `bounds` (the union),
 * `focal` and `pairs` ([{ a, b, matches, inliers }]).
 */
export function alignImages(images, opts = {}) {
  const { projection: wanted = 'auto', maxSize = 1000, maxFeatures = 1500, seed = 1, onProgress = null } = opts;
  const n = images.length;
  const feats = images.map((img, i) => {
    onProgress?.(i / (n * 2));
    return img.keypoints && img.descriptors ? img : detectFeatures(img, { maxSize, maxFeatures });
  });
  const sizes = images.map((img, i) => ({ width: img.width ?? feats[i].width, height: img.height ?? feats[i].height }));

  // ---- pairwise models (a -> b, a < b) ----
  const edges = [];
  const window = n > 12 ? 4 : n; // many images are assumed to be in shooting order: only near neighbours are tried
  let done = 0;
  const total = Math.max(1, (n * (n - 1)) / 2);
  for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) {
    onProgress?.(0.5 + (done++ / total) * 0.5);
    if (b - a > window) continue;
    const matches = matchDescriptors(feats[a], feats[b]);
    if (matches.length < MIN_INLIERS.translation) continue;
    const pts = matchedPoints(feats[a], feats[b], matches);
    // features found on a reduced copy are only that precise in full-size pixels
    const threshold = 3 / Math.min(1, feats[a].scale ?? 1, feats[b].scale ?? 1);
    const T = ransacTranslation(pts, { threshold, seed });
    const S = ransacSimilarity(pts, { threshold, seed });
    const Hm = pts.length >= 8 ? ransacHomography(pts, { threshold, seed }) : { H: null, inliers: [] };
    edges.push({ a, b, pts, matches: matches.length, threshold, T, S, H: Hm });
  }

  const count = (e, kind) => (kind === 'translation' ? e.T.inliers.length : kind === 'similarity' ? e.S.inliers.length : e.H.inliers.length);
  const valid = (e, kind) => count(e, kind) >= MIN_INLIERS[kind] && (kind !== 'homography' || !!e.H.H);

  // ---- which projection ----
  let projection = PROJECTIONS.includes(wanted) ? wanted : 'auto';
  if (projection === 'auto') {
    const strong = edges.filter((e) => valid(e, 'homography') || valid(e, 'similarity') || valid(e, 'translation'));
    const best = (e) => Math.max(count(e, 'translation'), count(e, 'similarity'), count(e, 'homography'));
    // the simplest motion that explains (nearly) all the matches wins: it moves pixels without resampling them
    if (!strong.length || strong.every((e) => valid(e, 'translation') && count(e, 'translation') >= 0.85 * best(e))) projection = 'reposition';
    else if (strong.every((e) => valid(e, 'similarity') && count(e, 'similarity') >= 0.85 * best(e))) projection = 'collage';
    else projection = 'perspective';
  }

  const solve = (proj) => {
    const kind = proj === 'reposition' ? 'translation' : proj === 'collage' ? 'similarity' : 'homography';
    const usable = edges.filter((e) => valid(e, kind));
    const reference = pickReference(n, usable, opts.reference);
    let focal = null;
    let models; // edge -> { forward: H (a -> b), backward: H (b -> a), inliers }
    if (proj === 'cylindrical' || proj === 'spherical') {
      focal = Number(opts.focal) > 0 ? Number(opts.focal) : estimateFocal(usable, sizes);
      models = new Map();
      for (const e of usable) {
        const sa = sizes[e.a], sb = sizes[e.b];
        const warped = e.H.inliers.map((k) => {
          const p = e.pts[k];
          const [u1, v1] = projectPoint(proj, focal, (sa.width - 1) / 2, (sa.height - 1) / 2, p.x1, p.y1);
          const [u2, v2] = projectPoint(proj, focal, (sb.width - 1) / 2, (sb.height - 1) / 2, p.x2, p.y2);
          return { x1: u1, y1: v1, x2: u2, y2: v2 };
        });
        const t = ransacTranslation(warped, { threshold: e.threshold * 1.5, seed });
        if (t.inliers.length < MIN_INLIERS.translation) continue;
        models.set(e, { forward: [1, 0, t.dx, 0, 1, t.dy, 0, 0, 1], backward: [1, 0, -t.dx, 0, 1, -t.dy, 0, 0, 1], inliers: t.inliers.length });
      }
    } else {
      models = new Map();
      for (const e of usable) {
        const forward = kind === 'homography' ? e.H.H : matrixToH(kind === 'similarity' ? e.S.matrix : e.T.matrix);
        const backward = invert3(forward);
        if (backward) models.set(e, { forward, backward, inliers: count(e, kind) });
      }
    }
    // breadth-first from the reference: the fewest chained models, the best supported parent on each level
    const chain = new Array(n).fill(null);
    const parent = new Array(n).fill(-1);
    const support = new Array(n).fill(0);
    chain[reference] = IDENTITY3.slice();
    let frontier = [reference];
    while (frontier.length) {
      const found = new Map(); // node -> { via, H, inliers }
      for (const p of frontier) {
        for (const [e, m] of models) {
          const other = e.a === p ? e.b : e.b === p ? e.a : -1;
          if (other < 0 || chain[other]) continue;
          const toParent = e.a === other ? m.forward : m.backward; // other -> p
          const prev = found.get(other);
          if (!prev || m.inliers > prev.inliers) found.set(other, { via: p, H: multiply3(chain[p], toParent), inliers: m.inliers });
        }
      }
      frontier = [];
      for (const [node, f] of found) {
        chain[node] = normalise3(f.H);
        parent[node] = f.via;
        support[node] = f.inliers;
        frontier.push(node);
      }
    }
    const warp = focal ? { type: proj, focal } : null;
    const refSize = sizes[reference];
    const out = [];
    let union = null;
    let degenerate = false;
    for (let i = 0; i < n; i++) {
      const matched = !!chain[i];
      const H = chain[i] ?? IDENTITY3.slice();
      const { width: w, height: h } = sizes[i];
      let bounds;
      if (warp) {
        // translations between warped images are relative to the centres: bring them into reference pixels
        const pb = projectedBounds(proj, focal, w, h);
        const x = Math.floor(pb.x1) + Math.round(H[2] + (refSize.width - 1) / 2), y = Math.floor(pb.y1) + Math.round(H[5] + (refSize.height - 1) / 2);
        bounds = { x, y, width: Math.max(1, Math.ceil(pb.x2) - Math.floor(pb.x1) + 1), height: Math.max(1, Math.ceil(pb.y2) - Math.floor(pb.y1) + 1) };
      } else {
        bounds = boundsUnderH(H, w, h);
        if (!bounds || bounds.width * bounds.height > 16 * w * h) {
          degenerate = true;
          bounds = bounds ?? { x: 0, y: 0, width: w, height: h };
        }
      }
      const affine = Math.abs(H[6]) < 1e-12 && Math.abs(H[7]) < 1e-12;
      out.push({ index: i, matched, homography: H, matrix: affine ? hToMatrix(H) : null, warp: warp ? { ...warp } : null, bounds, parent: parent[i], inliers: support[i] });
      union = unionBounds(union, bounds);
    }
    return { out, union, reference, focal, degenerate };
  };

  let solved = solve(projection);
  // a wide panorama stretches without limit on a plane: Auto falls back to the cylinder then
  if (wanted === 'auto' && projection === 'perspective') {
    const area = sizes.reduce((s, z) => s + z.width * z.height, 0);
    if (solved.degenerate || solved.union.width * solved.union.height > 2.5 * area) {
      projection = 'cylindrical';
      solved = solve(projection);
    }
  }
  const result = solved.out;
  result.projection = projection;
  result.reference = solved.reference;
  result.bounds = solved.union;
  result.focal = solved.focal;
  result.degenerate = solved.degenerate;
  result.pairs = edges.map((e) => ({ a: e.a, b: e.b, matches: e.matches, inliers: { translation: e.T.inliers.length, similarity: e.S.inliers.length, homography: e.H.inliers.length } }));
  // the matched point pairs of each tree edge (child -> parent), for vignette and distortion estimates
  result.samples = () => {
    const list = [];
    for (const t of result) {
      if (t.parent < 0) continue;
      const e = edges.find((x) => (x.a === t.index && x.b === t.parent) || (x.b === t.index && x.a === t.parent));
      if (!e) continue;
      const use = projection === 'reposition' ? e.T.inliers : projection === 'collage' ? e.S.inliers : e.H.inliers;
      list.push({ a: e.a, b: e.b, pairs: use.map((k) => e.pts[k]) });
    }
    return list;
  };
  return result;
}

/** The reference image: the asked one, else the centre of the match graph (ties: nearest to the middle of the list). */
function pickReference(n, edges, asked) {
  if (Number.isInteger(asked) && asked >= 0 && asked < n) return asked;
  const adj = Array.from({ length: n }, () => []);
  for (const e of edges) {
    adj[e.a].push(e.b);
    adj[e.b].push(e.a);
  }
  const mid = (n - 1) / 2;
  let best = Math.floor(mid), bestKey = null;
  for (let s = 0; s < n; s++) {
    const dist = new Array(n).fill(-1);
    dist[s] = 0;
    const queue = [s];
    let reached = 1, far = 0;
    for (let q = 0; q < queue.length; q++) for (const o of adj[queue[q]]) if (dist[o] < 0) {
      dist[o] = dist[queue[q]] + 1;
      far = Math.max(far, dist[o]);
      reached++;
      queue.push(o);
    }
    // most images reached, then the shortest longest chain, then the middle of the list
    const key = [-reached, far, Math.abs(s - mid), s];
    let better = !bestKey;
    for (let i = 0; !better && i < key.length; i++) {
      if (key[i] === bestKey[i]) continue;
      better = key[i] < bestKey[i];
      break;
    }
    if (better) {
      best = s;
      bestKey = key;
    }
  }
  return best;
}

/** Median focal length over the pair homographies; 0.8 × the mean width when none constrains it. */
function estimateFocal(edges, sizes) {
  const found = [];
  for (const e of edges) {
    if (!e.H.H) continue;
    const sa = sizes[e.a], sb = sizes[e.b];
    // centre both frames: Hc = C_b⁻¹ · H · C_a
    const Ca = [1, 0, (sa.width - 1) / 2, 0, 1, (sa.height - 1) / 2, 0, 0, 1];
    const CbInv = [1, 0, -(sb.width - 1) / 2, 0, 1, -(sb.height - 1) / 2, 0, 0, 1];
    const f = focalFromHomography(multiply3(CbInv, multiply3(e.H.H, Ca)));
    const w = (sa.width + sb.width) / 2;
    if (f && f > 0.3 * w && f < 6 * w) found.push(f);
  }
  if (!found.length) return 0.8 * (sizes.reduce((s, z) => s + z.width, 0) / Math.max(1, sizes.length));
  found.sort((a, b) => a - b);
  return found[found.length >> 1];
}

// ---- applying an alignment (pure; the renderer draws through canvases instead) ---------------------------------

/** Bilinear, premultiplied sample of img at pixel-index coordinates into out[o..o+3]; false when outside. */
function sampleInto(d, w, h, sx, sy, od, o) {
  if (sx <= -1 || sy <= -1 || sx >= w || sy >= h) return false;
  const x0 = Math.floor(sx), y0 = Math.floor(sy), tx = sx - x0, ty = sy - y0;
  let r = 0, g = 0, b = 0, a = 0;
  for (let j = 0; j < 2; j++) {
    const yy = y0 + j;
    if (yy < 0 || yy >= h) continue;
    const wy = j ? ty : 1 - ty;
    for (let i = 0; i < 2; i++) {
      const xx = x0 + i;
      if (xx < 0 || xx >= w) continue;
      const wgt = wy * (i ? tx : 1 - tx);
      if (!wgt) continue;
      const p = (yy * w + xx) * 4;
      const pa = d[p + 3] * wgt;
      r += d[p] * pa;
      g += d[p + 1] * pa;
      b += d[p + 2] * pa;
      a += pa;
    }
  }
  if (a < 0.5) return false;
  od[o] = r / a;
  od[o + 1] = g / a;
  od[o + 2] = b / a;
  od[o + 3] = a;
  return true;
}

/**
 * Renders an image through one entry of alignImages() into `rect` of the reference pixel space (default: the
 * entry's bounds). Used where no canvas is at hand (Merge to HDR's alignment hook, tests).
 */
export function applyAlignment(img, t, rect = t.bounds) {
  const out = createImage(rect.width, rect.height);
  const od = out.data;
  if (t.warp) {
    const warped = warpProjection(img, t.warp);
    const src = warped.image;
    for (let y = 0; y < rect.height; y++) {
      const sy = rect.y + y - t.bounds.y;
      if (sy < 0 || sy >= src.height) continue;
      for (let x = 0; x < rect.width; x++) {
        const sx = rect.x + x - t.bounds.x;
        if (sx < 0 || sx >= src.width) continue;
        const s = (sy * src.width + sx) * 4, o = (y * rect.width + x) * 4;
        od[o] = src.data[s];
        od[o + 1] = src.data[s + 1];
        od[o + 2] = src.data[s + 2];
        od[o + 3] = src.data[s + 3];
      }
    }
    return out;
  }
  const inv = invert3(t.homography);
  if (!inv) return out;
  const { width: w, height: h, data: d } = img;
  for (let y = 0; y < rect.height; y++) {
    const ry = rect.y + y;
    for (let x = 0; x < rect.width; x++) {
      const rx = rect.x + x;
      const ww = inv[6] * rx + inv[7] * ry + inv[8];
      if (ww <= 1e-9) continue;
      sampleInto(d, w, h, (inv[0] * rx + inv[1] * ry + inv[2]) / ww, (inv[3] * rx + inv[4] * ry + inv[5]) / ww, od, (y * rect.width + x) * 4);
    }
  }
  return out;
}

// ---- vignette --------------------------------------------------------------------------------------------------

/** Mean luminance of the (2r+1)² box around a point; -1 when the box leaves the image or touches transparency. */
function boxLuma(img, x, y, r = 3) {
  const { width: w, height: h, data: d } = img;
  const cx = Math.round(x), cy = Math.round(y);
  if (cx < r || cy < r || cx >= w - r || cy >= h - r) return -1;
  let sum = 0;
  for (let yy = cy - r; yy <= cy + r; yy++) for (let xx = cx - r; xx <= cx + r; xx++) {
    const i = (yy * w + xx) * 4;
    if (d[i + 3] < 255) return -1;
    sum += d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
  }
  return sum / ((2 * r + 1) * (2 * r + 1));
}

/**
 * Estimates the lens vignette shared by the images from the brightness of matched points: the same scene point
 * is darker in the image where it sits further from the centre. Model: observed = scene / (1 + v·ρ²), ρ = the
 * distance from the image centre over the half diagonal. `samples` is alignImages().samples(). Returns
 * { amount: v (0 when it could not be estimated), samples: the number of point pairs used }.
 */
export function estimateVignette(images, samples) {
  let num = 0, den = 0, used = 0;
  for (const s of samples) {
    const A = images[s.a], B = images[s.b];
    const ra2 = (A.width * A.width + A.height * A.height) / 4, rb2 = (B.width * B.width + B.height * B.height) / 4;
    const rows = [];
    let sumA = 0, sumB = 0;
    for (const p of s.pairs) {
      const la = boxLuma(A, p.x1, p.y1), lb = boxLuma(B, p.x2, p.y2);
      if (la < 8 || lb < 8 || la > 247 || lb > 247) continue;
      const pa = ((p.x1 - (A.width - 1) / 2) ** 2 + (p.y1 - (A.height - 1) / 2) ** 2) / ra2;
      const pb = ((p.x2 - (B.width - 1) / 2) ** 2 + (p.y2 - (B.height - 1) / 2) ** 2) / rb2;
      rows.push([la, lb, pa, pb]);
      sumA += la;
      sumB += lb;
    }
    if (rows.length < 12) continue;
    // an exposure difference between the two frames is not vignette: take it out first
    const k = sumA / sumB;
    for (const [la, lbRaw, pa, pb] of rows) {
      const lb = lbRaw * k;
      // la (1 + v pa) = lb (1 + v pb)  =>  v (la pa - lb pb) = lb - la
      const c = la * pa - lb * pb, r = lb - la;
      num += c * r;
      den += c * c;
      used++;
    }
  }
  if (used < 24 || den < 1e-6) return { amount: 0, samples: used };
  const v = num / den;
  // a real lens darkens towards the corners by up to about two stops; anything else is a bad fit
  return { amount: v > 0.02 && v < 3 ? v : 0, samples: used };
}

/** Brightens an image towards its corners by 1 + amount·ρ² (the inverse of the vignette model), in place. */
export function removeVignette(img, amount) {
  if (!(amount > 0)) return img;
  const { width: w, height: h, data: d } = img;
  const cx = (w - 1) / 2, cy = (h - 1) / 2, r2 = (w * w + h * h) / 4;
  for (let y = 0; y < h; y++) {
    const dy2 = (y - cy) * (y - cy);
    for (let x = 0; x < w; x++) {
      const g = 1 + (amount * ((x - cx) * (x - cx) + dy2)) / r2;
      const i = (y * w + x) * 4;
      d[i] = d[i] * g;
      d[i + 1] = d[i + 1] * g;
      d[i + 2] = d[i + 2] * g;
    }
  }
  return img;
}

// ---- radial lens distortion ---------------------------------------------------------------------------------------

/** Undistorted position of a distorted point for x_d = x_u (1 + k·r_u²) (r over the half diagonal), by fixed-point iteration. */
function undistortPoint(k, cx, cy, r2, x, y) {
  const dx = x - cx, dy = y - cy;
  let ux = dx, uy = dy;
  for (let it = 0; it < 6; it++) {
    const s = 1 + (k * (ux * ux + uy * uy)) / r2;
    ux = dx / s;
    uy = dy / s;
  }
  return [cx + ux, cy + uy];
}

/**
 * Estimates one radial distortion coefficient shared by the images: the k for which the matched points, once
 * undistorted, are best explained by homographies. `samples` is alignImages().samples() of a perspective
 * alignment. Returns { k (0 when the matches do not support a correction), improvement (ratio of the residuals) }.
 */
export function estimateDistortion(sizes, samples) {
  const usable = samples.filter((s) => s.pairs.length >= 30);
  if (!usable.length) return { k: 0, improvement: 0 };
  const residual = (k) => {
    let sum = 0, count = 0;
    for (const s of usable) {
      const A = sizes[s.a], B = sizes[s.b];
      const ax = (A.width - 1) / 2, ay = (A.height - 1) / 2, ar = (A.width * A.width + A.height * A.height) / 4;
      const bx = (B.width - 1) / 2, by = (B.height - 1) / 2, br = (B.width * B.width + B.height * B.height) / 4;
      const pts = s.pairs.map((p) => {
        const [x1, y1] = k ? undistortPoint(k, ax, ay, ar, p.x1, p.y1) : [p.x1, p.y1];
        const [x2, y2] = k ? undistortPoint(k, bx, by, br, p.x2, p.y2) : [p.x2, p.y2];
        return { x1, y1, x2, y2 };
      });
      const H = fitHomography(pts);
      if (!H) return Infinity;
      for (const p of pts) sum += Math.min(100, errH(H, p));
      count += pts.length;
    }
    return Math.sqrt(sum / Math.max(1, count));
  };
  const base = residual(0);
  if (!Number.isFinite(base) || base < 0.15) return { k: 0, improvement: 1 }; // already as good as the features are
  // golden-section search over a plausible range of barrel (k < 0 here bulges outwards) and pincushion
  let lo = -0.3, hi = 0.3;
  const phi = (Math.sqrt(5) - 1) / 2;
  let c = hi - phi * (hi - lo), d = lo + phi * (hi - lo);
  let fc = residual(c), fd = residual(d);
  for (let it = 0; it < 24; it++) {
    if (fc < fd) {
      hi = d;
      d = c;
      fd = fc;
      c = hi - phi * (hi - lo);
      fc = residual(c);
    } else {
      lo = c;
      c = d;
      fc = fd;
      d = lo + phi * (hi - lo);
      fd = residual(d);
    }
  }
  const k = (lo + hi) / 2;
  const best = residual(k);
  // only a clear gain is trusted: features scatter by a fraction of a pixel anyway
  if (!(best < base * 0.75) || Math.abs(k) < 0.004) return { k: 0, improvement: best / base };
  return { k, improvement: best / base };
}

/** Resamples an image so that its radial distortion k (see estimateDistortion) is removed; same size, new image. */
export function undistortImage(img, k) {
  const { width: w, height: h, data: d } = img;
  const out = createImage(w, h);
  if (!k) {
    out.data.set(d);
    return out;
  }
  const cx = (w - 1) / 2, cy = (h - 1) / 2, r2 = (w * w + h * h) / 4;
  for (let y = 0; y < h; y++) {
    const uy = y - cy;
    for (let x = 0; x < w; x++) {
      const ux = x - cx;
      const s = 1 + (k * (ux * ux + uy * uy)) / r2;
      sampleInto(d, w, h, cx + ux * s, cy + uy * s, out.data, (y * w + x) * 4);
    }
  }
  return out;
}

// ---- Auto-Blend: seams and gains -------------------------------------------------------------------------------

/**
 * Distance of every covered pixel to the nearest uncovered one or to the border of the frame (3-4 chamfer,
 * in pixels). `cover` is a Uint8 array, non-zero = covered.
 */
export function distanceToEdge(cover, w, h) {
  const INF = 1e9;
  const dist = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (!cover[i]) continue;
    let v = INF;
    // the frame border counts as an edge: a layer that fills the frame is still "furthest from its edge" in the middle
    if (x === 0 || y === 0) v = 3;
    else {
      v = Math.min(v, dist[i - 1] + 3, dist[i - w] + 3, dist[i - w - 1] + 4);
      if (x + 1 < w) v = Math.min(v, dist[i - w + 1] + 4);
      else v = Math.min(v, 3);
    }
    dist[i] = v;
  }
  for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
    const i = y * w + x;
    if (!cover[i]) continue;
    let v = dist[i];
    if (x === w - 1 || y === h - 1) v = Math.min(v, 3);
    else {
      v = Math.min(v, dist[i + 1] + 3, dist[i + w] + 3, dist[i + w + 1] + 4);
      if (x > 0) v = Math.min(v, dist[i + w - 1] + 4);
      else v = Math.min(v, 3);
    }
    dist[i] = v;
  }
  for (let i = 0; i < dist.length; i++) dist[i] /= 3;
  return dist;
}

/** Three box blurs (≈ a Gaussian of σ ≈ radius) of a float map, in place. */
function blurMap(map, w, h, radius) {
  const r = Math.max(0, Math.round(radius));
  if (!r) return map;
  const tmp = new Float32Array(Math.max(w, h));
  const norm = 1 / (2 * r + 1);
  for (let pass = 0; pass < 3; pass++) {
    for (let y = 0; y < h; y++) {
      const row = y * w;
      let sum = 0;
      for (let k = -r; k <= r; k++) sum += map[row + Math.min(w - 1, Math.max(0, k))];
      for (let x = 0; x < w; x++) {
        tmp[x] = sum * norm;
        sum += map[row + Math.min(w - 1, x + r + 1)] - map[row + Math.max(0, x - r)];
      }
      for (let x = 0; x < w; x++) map[row + x] = tmp[x];
    }
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let k = -r; k <= r; k++) sum += map[Math.min(h - 1, Math.max(0, k)) * w + x];
      for (let y = 0; y < h; y++) {
        tmp[y] = sum * norm;
        sum += map[Math.min(h - 1, y + r + 1) * w + x] - map[Math.max(0, y - r) * w + x];
      }
      for (let y = 0; y < h; y++) map[y * w + x] = tmp[y];
    }
  }
  return map;
}

/**
 * Layer masks for Auto-Blend. `alphas` are the layers' alpha planes (Uint8, width × height, bottom layer
 * first) in one common frame. Every covered pixel is given to the layer with the largest weight there (by
 * default its distance to that layer's own edge, so seams run through the middle of each overlap); the seams
 * are then feathered and the result is turned into masks for normal ("over") compositing: the lowest layer
 * covering a pixel is opaque, each layer above it carries its share, so the blend has no holes.
 *
 * Options: feather (pixels; default 10% of the widest overlap, 1..64), weights (Float32Array per layer,
 * larger wins: Stack Images passes local sharpness), maxPixels (the seam is computed on a reduced copy above
 * this size and scaled back up). Returns { masks: Uint8ClampedArray[] (0..255), feather, overlap (px), labels }.
 */
export function seamMasks(alphas, width, height, { feather = null, weights = null, maxPixels = 1.5e6 } = {}) {
  const n = alphas.length;
  const s = Math.min(1, Math.sqrt(maxPixels / Math.max(1, width * height)));
  const w = Math.max(1, Math.round(width * s)), h = Math.max(1, Math.round(height * s));
  const kx = width / w, ky = height / h;
  const reduce = (plane, asCover) => {
    if (w === width && h === height && !asCover) return plane;
    const out = asCover ? new Uint8Array(w * h) : new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      const ya = Math.floor(y * ky), yb = Math.max(ya + 1, Math.min(height, Math.floor((y + 1) * ky)));
      for (let x = 0; x < w; x++) {
        const xa = Math.floor(x * kx), xb = Math.max(xa + 1, Math.min(width, Math.floor((x + 1) * kx)));
        let sum = 0;
        for (let yy = ya; yy < yb; yy++) for (let xx = xa; xx < xb; xx++) sum += plane[yy * width + xx];
        const mean = sum / ((yb - ya) * (xb - xa));
        out[y * w + x] = asCover ? (mean >= 128 ? 1 : 0) : mean;
      }
    }
    return out;
  };
  const cover = alphas.map((a) => reduce(a, true));
  const dist = cover.map((c) => distanceToEdge(c, w, h));
  const weight = weights ? weights.map((m) => reduce(m, false)) : dist;
  // hard labels: the heaviest covering layer; the widest overlap is twice the largest runner-up edge distance
  const labels = new Int16Array(w * h).fill(-1);
  let runnerUp = 0;
  for (let i = 0; i < w * h; i++) {
    let best = -1, bw = -Infinity, second = 0, covering = 0;
    for (let k = 0; k < n; k++) {
      if (!cover[k][i]) continue;
      covering++;
      const v = weight[k][i];
      // ties go to the upper layer, which is the one that would be seen without masks
      if (v >= bw) {
        bw = v;
        best = k;
      }
    }
    labels[i] = best;
    if (covering > 1) {
      for (let k = 0; k < n; k++) if (k !== best && cover[k][i] && dist[k][i] > second) second = dist[k][i];
      const m = Math.min(second, dist[best][i]);
      if (m > runnerUp) runnerUp = m;
    }
  }
  const overlap = (2 * runnerUp) / s;
  const f = feather === null || feather === undefined ? Math.min(64, Math.max(1, overlap * 0.1)) : Math.max(0, feather);
  // feathered shares; a layer's share never leaves its own coverage
  const share = [];
  for (let k = 0; k < n; k++) {
    const m = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) m[i] = labels[i] === k ? 1 : 0;
    // three box passes of radius r spread about r·√3: a third of the feather per pass gives a ramp of that width
    blurMap(m, w, h, (f * s) / 2);
    share.push(m);
  }
  const masks = alphas.map(() => new Uint8ClampedArray(width * height));
  const c = new Float32Array(n);
  for (let y = 0; y < height; y++) {
    // bilinear position in the reduced maps
    const fy = Math.min(h - 1, Math.max(0, (y + 0.5) / ky - 0.5));
    const y0 = Math.floor(fy), y1 = Math.min(h - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      let x0 = x, x1 = x, tx = 0;
      if (w !== width) {
        const fx = Math.min(w - 1, Math.max(0, (x + 0.5) / kx - 0.5));
        x0 = Math.floor(fx);
        x1 = Math.min(w - 1, x0 + 1);
        tx = fx - x0;
      }
      let sum = 0, top = -1;
      for (let k = 0; k < n; k++) {
        if (alphas[k][i] === 0) {
          c[k] = 0;
          continue;
        }
        top = k;
        const m = share[k];
        const v = w === width && h === height ? m[i] : (m[y0 * w + x0] * (1 - tx) + m[y0 * w + x1] * tx) * (1 - ty) + (m[y1 * w + x0] * (1 - tx) + m[y1 * w + x1] * tx) * ty;
        c[k] = v < 1e-4 ? 0 : v;
        sum += c[k];
      }
      if (top < 0) continue; // nothing here: every mask stays black
      if (sum <= 0) {
        c[top] = 1; // covered, but the reduced labels missed it (a thin sliver): the upper layer shows
        sum = 1;
      }
      // over-compositing: mask_k = share_k / (share_0 + … + share_k); the lowest layer that has pixels here is
      // opaque whatever its share (nothing lies below it), which is what rules holes out
      let below = 0, lowest = true;
      for (let k = 0; k < n; k++) {
        if (alphas[k][i] === 0) continue;
        below += c[k];
        masks[k][i] = lowest ? 255 : c[k] ? Math.round((c[k] / below) * 255) : 0;
        lowest = false;
      }
    }
  }
  return { masks, feather: f, overlap, labels, width: w, height: h };
}

/**
 * Local sharpness of an image for focus stacking: the absolute Laplacian of the luminance, averaged over a
 * small window (Float32Array, width × height). Transparent pixels score 0.
 */
export function focusMeasure(img, radius = 4) {
  const { width: w, height: h, data: d } = img;
  const lum = new Float32Array(w * h);
  for (let p = 0, i = 0; p < w * h; p++, i += 4) lum[p] = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
  const out = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    if (d[i * 4 + 3] === 0) continue;
    out[i] = Math.abs(4 * lum[i] - lum[i - 1] - lum[i + 1] - lum[i - w] - lum[i + w]);
  }
  return blurMap(out, w, h, radius);
}

/**
 * Gain compensation (Brown & Lowe): one gain per layer and channel so that the layers agree where they
 * overlap, with a prior that keeps the gains near 1. `frames` are RGBA images of one size (the layers in a
 * common frame). Returns [[gr, gg, gb], …]; `perChannel: false` gives one luminance gain per layer.
 */
export function gainCompensation(frames, { perChannel = true, step = null } = {}) {
  const n = frames.length;
  const gains = frames.map(() => [1, 1, 1]);
  if (n < 2) return gains;
  const { width: w, height: h } = frames[0];
  const st = step ?? Math.max(1, Math.round(Math.sqrt((w * h) / 250000)));
  const N = Array.from({ length: n }, () => new Float64Array(n));
  const S = Array.from({ length: n }, () => Array.from({ length: n }, () => new Float64Array(3))); // S[i][j]: sum of i over the overlap with j
  const present = new Int32Array(n);
  for (let y = 0; y < h; y += st) for (let x = 0; x < w; x += st) {
    const o = (y * w + x) * 4;
    let m = 0;
    for (let k = 0; k < n; k++) if (frames[k].data[o + 3] >= 250) present[m++] = k;
    if (m < 2) continue;
    for (let a = 0; a < m; a++) for (let b = 0; b < m; b++) {
      if (a === b) continue;
      const i = present[a], j = present[b];
      const d = frames[i].data;
      N[i][j]++;
      S[i][j][0] += d[o];
      S[i][j][1] += d[o + 1];
      S[i][j][2] += d[o + 2];
    }
  }
  const sigmaN = 10, sigmaG = 0.2;
  const solveFor = (mean) => {
    const A = Array.from({ length: n }, () => new Array(n).fill(0));
    const b = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if (i === j || !N[i][j]) continue;
        const aij = mean(i, j), aji = mean(j, i);
        A[i][i] += N[i][j] * ((2 * aij * aij) / (sigmaN * sigmaN) + 1 / (sigmaG * sigmaG));
        A[i][j] -= (2 * N[i][j] * aij * aji) / (sigmaN * sigmaN);
        b[i] += N[i][j] / (sigmaG * sigmaG);
      }
      if (!A[i][i]) {
        A[i][i] = 1; // overlaps nothing: its gain stays 1
        b[i] = 1;
      }
    }
    const g = solveLinear(A, b);
    return g ? g.map((v) => (Number.isFinite(v) ? Math.min(2, Math.max(0.5, v)) : 1)) : new Array(n).fill(1);
  };
  if (perChannel) {
    for (let c = 0; c < 3; c++) {
      const g = solveFor((i, j) => S[i][j][c] / N[i][j]);
      for (let i = 0; i < n; i++) gains[i][c] = g[i];
    }
  } else {
    const g = solveFor((i, j) => (S[i][j][0] * 0.299 + S[i][j][1] * 0.587 + S[i][j][2] * 0.114) / N[i][j]);
    for (let i = 0; i < n; i++) gains[i] = [g[i], g[i], g[i]];
  }
  return gains;
}

/** Multiplies the colour channels of an image by per-channel gains, in place. */
export function applyGain(img, gain) {
  const d = img.data;
  const [gr, gg, gb] = gain;
  if (gr === 1 && gg === 1 && gb === 1) return img;
  for (let i = 0; i < d.length; i += 4) {
    d[i] = d[i] * gr;
    d[i + 1] = d[i + 1] * gg;
    d[i + 2] = d[i + 2] * gb;
  }
  return img;
}
