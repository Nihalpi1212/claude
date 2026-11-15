// Layer > Matting (builder "adjust-more"): Defringe, Remove Black / White Matte and Color
// Decontaminate on ImageDataLike objects. Pure, no DOM.
//
// All three repair the colours of edge pixels of a cut-out and never change alpha:
//   defringe(img, width)          edge pixels (within `width` px of full transparency) take the colour of
//                                 the nearest pixel farther inside
//   removeMatte(img, 'black'|'white')  semi-transparent pixels are un-mixed from the matte colour they were
//                                 anti-aliased against
//   decontaminate(img, amount)    semi-transparent pixels move towards the nearest solid interior colour,
//                                 the more transparent the further
// Conventions: straight alpha, rect limits writes only, nothing outside the image is read; the
// image border is not an edge (a layer that fills its canvas has no fringe there).

import { clampRect } from './core.js';

/** @typedef {import('./core.js').ImageDataLike} ImageDataLike */
/** @typedef {import('./core.js').Rect} Rect */

const INF = 1e20;

/**
 * Exact Euclidean feature transform (Felzenszwalb & Huttenlocher's two 1D lower-envelope passes):
 * for every pixel the index of the nearest pixel whose `source` flag is set and the squared distance
 * to it. Pixels get index -1 when there is no source at all.
 * @param {Uint8Array} source w*h flags
 * @returns {{ index: Int32Array, dist2: Float32Array }}
 */
export function nearestSource(source, w, h) {
  const n = w * h;
  const index = new Int32Array(n).fill(-1);
  const dist2 = new Float32Array(n).fill(INF);
  // pass 1, columns: nearest source in the same column (two sweeps)
  const colY = new Int32Array(n).fill(-1); // row of the nearest source in this column
  for (let x = 0; x < w; x++) {
    let last = -1;
    for (let y = 0; y < h; y++) {
      const p = y * w + x;
      if (source[p]) last = y;
      if (last >= 0) {
        colY[p] = last;
        dist2[p] = (y - last) * (y - last);
      }
    }
    last = -1;
    for (let y = h - 1; y >= 0; y--) {
      const p = y * w + x;
      if (source[p]) last = y;
      if (last >= 0 && (last - y) * (last - y) < dist2[p]) {
        colY[p] = last;
        dist2[p] = (last - y) * (last - y);
      }
    }
  }
  // pass 2, rows: lower envelope of the parabolas f(q) + (x - q)²
  const v = new Int32Array(w), z = new Float64Array(w + 1), f = new Float64Array(w), outD = new Float32Array(w), outQ = new Int32Array(w);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let any = false;
    for (let x = 0; x < w; x++) {
      f[x] = dist2[row + x];
      if (f[x] < INF) any = true;
    }
    if (!any) continue;
    let k = -1;
    for (let q = 0; q < w; q++) {
      if (f[q] >= INF) continue;
      let s = 0;
      while (k >= 0) {
        const p = v[k];
        s = (f[q] + q * q - (f[p] + p * p)) / (2 * q - 2 * p);
        if (s <= z[k]) k--;
        else break;
      }
      k++;
      v[k] = q;
      z[k] = k === 0 ? -INF : s;
      z[k + 1] = INF;
    }
    let j = 0;
    for (let x = 0; x < w; x++) {
      while (z[j + 1] < x) j++;
      const q = v[j];
      outD[x] = (x - q) * (x - q) + f[q];
      outQ[x] = q;
    }
    for (let x = 0; x < w; x++) {
      const q = outQ[x];
      dist2[row + x] = outD[x];
      index[row + x] = colY[row + q] * w + q;
    }
  }
  return { index, dist2 };
}

/**
 * Defringe: every non-transparent pixel within `width` pixels of a fully transparent one takes the
 * colour of the nearest pixel that lies farther inside (more than `width` px from transparency).
 * Shapes too thin to have such an interior are left alone. In place; returns img.
 * @param {ImageDataLike} img
 * @param {number} [width=1] 1..200 px
 * @param {Rect | null} [rect]
 */
export function defringe(img, width = 1, rect = null) {
  const w = img.width, h = img.height, d = img.data, n = w * h;
  const r = clampRect(rect, w, h);
  const wd = Math.max(1, Math.min(200, +width || 1));
  if (!n || r.width <= 0) return img;
  const clear = new Uint8Array(n);
  let anyClear = false;
  for (let p = 0, i = 3; p < n; p++, i += 4) if (d[i] === 0) {
    clear[p] = 1;
    anyClear = true;
  }
  if (!anyClear) return img;
  const edge = nearestSource(clear, w, h).dist2;
  const limit = wd * wd + 1e-3;
  const inside = new Uint8Array(n);
  let anyInside = false;
  for (let p = 0; p < n; p++) if (!clear[p] && edge[p] > limit) {
    inside[p] = 1;
    anyInside = true;
  }
  if (!anyInside) return img;
  const near = nearestSource(inside, w, h).index;
  // sources are never written (they are farther inside than the fringe), so reading d while writing is safe
  for (let y = r.y, ye = r.y + r.height; y < ye; y++) {
    for (let x = r.x, xe = r.x + r.width; x < xe; x++) {
      const p = y * w + x;
      if (clear[p] || inside[p]) continue;
      const s = near[p];
      if (s < 0) continue;
      d[p * 4] = d[s * 4];
      d[p * 4 + 1] = d[s * 4 + 1];
      d[p * 4 + 2] = d[s * 4 + 2];
    }
  }
  return img;
}

/**
 * Remove Black / White Matte: a pixel anti-aliased against the matte holds C·a + M·(1 - a); solving
 * for C un-mixes the matte from every semi-transparent pixel. In place; returns img.
 * @param {ImageDataLike} img
 * @param {'black' | 'white'} [matte='black']
 * @param {Rect | null} [rect]
 */
export function removeMatte(img, matte = 'black', rect = null) {
  const w = img.width, d = img.data;
  const r = clampRect(rect, w, img.height);
  if (r.width <= 0) return img;
  const m = matte === 'white' ? 255 : 0;
  for (let y = r.y, ye = r.y + r.height; y < ye; y++) {
    let i = (y * w + r.x) * 4;
    for (let x = 0; x < r.width; x++, i += 4) {
      const a = d[i + 3];
      if (a === 0 || a === 255) continue;
      const k = 255 / a;
      // Uint8ClampedArray clamps and rounds
      d[i] = (d[i] - m) * k + m;
      d[i + 1] = (d[i + 1] - m) * k + m;
      d[i + 2] = (d[i + 2] - m) * k + m;
    }
  }
  return img;
}

/**
 * Color Decontaminate: semi-transparent pixels are pulled towards the colour of the nearest solid
 * interior pixel (fully opaque and not touching the soft edge). The pull is amount/100 for pixels
 * at most half opaque and fades to nothing at full opacity. In place; returns img.
 * @param {ImageDataLike} img
 * @param {number} [amount=100] 0..100
 * @param {Rect | null} [rect]
 */
export function decontaminate(img, amount = 100, rect = null) {
  const w = img.width, h = img.height, d = img.data, n = w * h;
  const r = clampRect(rect, w, h);
  const amt = Math.max(0, Math.min(100, +amount || 0)) / 100;
  if (!n || r.width <= 0 || amt <= 0) return img;
  // solid = opaque; interior = solid pixels whose 4-neighbours are all solid (the rim itself may be tinted)
  const solid = new Uint8Array(n);
  let soft = false;
  for (let p = 0, i = 3; p < n; p++, i += 4) {
    if (d[i] === 255) solid[p] = 1;
    else if (d[i] > 0) soft = true;
  }
  if (!soft) return img;
  const interior = new Uint8Array(n);
  let any = false;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = y * w + x;
    if (!solid[p]) continue;
    if ((x > 0 && !solid[p - 1]) || (x < w - 1 && !solid[p + 1]) || (y > 0 && !solid[p - w]) || (y < h - 1 && !solid[p + w])) continue;
    interior[p] = 1;
    any = true;
  }
  const near = nearestSource(any ? interior : solid, w, h).index;
  for (let y = r.y, ye = r.y + r.height; y < ye; y++) {
    for (let x = r.x, xe = r.x + r.width; x < xe; x++) {
      const p = y * w + x, i = p * 4;
      const a = d[i + 3];
      if (a === 0 || a === 255) continue;
      const s = near[p];
      if (s < 0) continue;
      const t = amt * Math.min(1, 2 * (1 - a / 255));
      d[i] += (d[s * 4] - d[i]) * t;
      d[i + 1] += (d[s * 4 + 1] - d[i + 1]) * t;
      d[i + 2] += (d[s * 4 + 2] - d[i + 2]) * t;
    }
  }
  return img;
}
