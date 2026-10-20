// Content-aware fill: fills the masked pixels of an image with texture synthesised from the rest
// of it (multi-scale PatchMatch + patch voting, after Wexler et al. 2007 and Barnes et al. 2009).
// Pure JavaScript on ImageDataLike { width, height, data } with straight alpha; deterministic for
// a given seed.

/** @typedef {{ width: number, height: number, data: Uint8ClampedArray }} ImageDataLike */

function rng(seed) {
  let s = (seed >>> 0) || 0x9e3779b9;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

/** Float RGBA copy of a sub-rect. */
function crop(img, r) {
  const out = new Float32Array(r.width * r.height * 4);
  for (let y = 0; y < r.height; y++) {
    const si = ((r.y + y) * img.width + r.x) * 4;
    for (let i = 0; i < r.width * 4; i++) out[y * r.width * 4 + i] = img.data[si + i];
  }
  return out;
}

/** Downsamples a level by 2 (box filter over known pixels; a pixel is a hole if any of its 4 is). */
function downsample(level) {
  const w = Math.max(1, Math.ceil(level.w / 2)), h = Math.max(1, Math.ceil(level.h / 2));
  const px = new Float32Array(w * h * 4), hole = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let n = 0, isHole = 0;
      const acc = [0, 0, 0, 0];
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const sx = Math.min(level.w - 1, x * 2 + dx), sy = Math.min(level.h - 1, y * 2 + dy);
          const si = sy * level.w + sx;
          if (level.hole[si]) {
            isHole = 1;
            continue;
          }
          for (let c = 0; c < 4; c++) acc[c] += level.px[si * 4 + c];
          n++;
        }
      }
      const o = y * w + x;
      hole[o] = isHole;
      if (n) for (let c = 0; c < 4; c++) px[o * 4 + c] = acc[c] / n;
    }
  }
  return { w, h, px, hole };
}

/** valid[q] = 1 when the patch centred at q lies inside the level and holds no hole pixel. */
function validSources(level, r) {
  const { w, h, hole } = level;
  // integral image of hole pixels
  const sat = new Int32Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += hole[y * w + x];
      sat[(y + 1) * (w + 1) + x + 1] = sat[y * (w + 1) + x + 1] + row;
    }
  }
  const valid = new Uint8Array(w * h);
  let count = 0;
  for (let y = r; y < h - r; y++) {
    for (let x = r; x < w - r; x++) {
      const x0 = x - r, y0 = y - r, x1 = x + r + 1, y1 = y + r + 1;
      const s = sat[y1 * (w + 1) + x1] - sat[y0 * (w + 1) + x1] - sat[y1 * (w + 1) + x0] + sat[y0 * (w + 1) + x0];
      if (s === 0) {
        valid[y * w + x] = 1;
        count++;
      }
    }
  }
  return { valid, count };
}

/**
 * Fills mask > 127 pixels of img in place.
 * @param {ImageDataLike} img
 * @param {Uint8Array|Uint8ClampedArray} mask   img-sized, 255 = fill
 * @param {{ patch?: number, iterations?: number, seed?: number, margin?: number }} [opts]
 *   patch: patch size (odd, default 7); iterations: EM iterations at the finest level (default 4);
 *   margin: how far around the hole to look for texture (default: 2 × the hole's size, at least 32 px)
 * @returns {ImageDataLike} img
 */
export function inpaint(img, mask, opts = {}) {
  const W = img.width, H = img.height;
  const patch = Math.max(3, (opts.patch ?? 7) | 1);
  const r = patch >> 1;
  // hole bounds
  let x1 = W, y1 = H, x2 = -1, y2 = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (mask[y * W + x] > 127) {
    if (x < x1) x1 = x;
    if (x > x2) x2 = x;
    if (y < y1) y1 = y;
    if (y > y2) y2 = y;
  }
  if (x2 < 0) return img;
  const hw = x2 - x1 + 1, hh = y2 - y1 + 1;
  const margin = Math.max(32, opts.margin ?? Math.max(hw, hh) * 2);
  const R = { x: Math.max(0, x1 - margin), y: Math.max(0, y1 - margin) };
  R.width = Math.min(W, x2 + 1 + margin) - R.x;
  R.height = Math.min(H, y2 + 1 + margin) - R.y;

  // finest level
  const base = { w: R.width, h: R.height, px: crop(img, R), hole: new Uint8Array(R.width * R.height) };
  for (let y = 0; y < R.height; y++) for (let x = 0; x < R.width; x++) base.hole[y * R.width + x] = mask[(R.y + y) * W + R.x + x] > 127 ? 1 : 0;
  if (validSources(base, r).count === 0) return img; // nothing to copy from

  // pyramid: stop when the hole is small or the level too small for patches
  const levels = [base];
  while (true) {
    const top = levels[levels.length - 1];
    if (Math.min(top.w, top.h) < patch * 4) break;
    let holeMax = 0;
    {
      let hx1 = top.w, hx2 = -1, hy1 = top.h, hy2 = -1;
      for (let y = 0; y < top.h; y++) for (let x = 0; x < top.w; x++) if (top.hole[y * top.w + x]) {
        if (x < hx1) hx1 = x;
        if (x > hx2) hx2 = x;
        if (y < hy1) hy1 = y;
        if (y > hy2) hy2 = y;
      }
      holeMax = Math.max(hx2 - hx1 + 1, hy2 - hy1 + 1);
    }
    if (holeMax <= patch * 2) break;
    const next = downsample(top);
    if (validSources(next, r).count < 4) break;
    levels.push(next);
  }

  const random = rng(opts.seed ?? 1);
  let nnf = null; // Int32Array of source indices per pixel (only meaningful for target pixels)
  for (let li = levels.length - 1; li >= 0; li--) {
    const L = levels[li];
    const { w, h, px, hole } = L;
    const { valid, count } = validSources(L, r);
    const validList = new Int32Array(count);
    for (let i = 0, k = 0; i < valid.length; i++) if (valid[i]) validList[k++] = i;
    // target pixels: those whose patch touches the hole
    const target = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (hole[y * w + x]) {
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        const tx = x + dx, ty = y + dy;
        if (tx >= 0 && ty >= 0 && tx < w && ty < h) target[ty * w + tx] = 1;
      }
    }
    const known = new Uint8Array(w * h);
    for (let i = 0; i < known.length; i++) known[i] = hole[i] ? 0 : 1;

    // current estimate of hole pixels: upsampled from the coarser level, or unknown at the top
    if (li < levels.length - 1) {
      const C = levels[li + 1];
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!hole[i]) continue;
        const ci = Math.min(C.h - 1, y >> 1) * C.w + Math.min(C.w - 1, x >> 1);
        for (let c = 0; c < 4; c++) px[i * 4 + c] = C.px[ci * 4 + c];
        known[i] = 1;
      }
    }

    // NNF init: upsample the coarser field, else random valid sources
    const field = new Int32Array(w * h).fill(-1);
    for (let i = 0; i < w * h; i++) {
      if (!target[i]) continue;
      let s = -1;
      if (nnf && li < levels.length - 1) {
        const C = levels[li + 1];
        const x = i % w, y = (i / w) | 0;
        const ci = Math.min(C.h - 1, y >> 1) * C.w + Math.min(C.w - 1, x >> 1);
        const cs = nnf[ci];
        if (cs >= 0) {
          const sx = (cs % C.w) * 2 + (x & 1), sy = ((cs / C.w) | 0) * 2 + (y & 1);
          if (sx < w && sy < h && valid[sy * w + sx]) s = sy * w + sx;
        }
      }
      if (s < 0) s = validList[(random() * count) | 0];
      field[i] = s;
    }

    const dist = (t, s, cutoff) => {
      const tx = t % w, ty = (t / w) | 0, sx = s % w, sy = (s / w) | 0;
      let d = 0, n = 0;
      for (let dy = -r; dy <= r; dy++) {
        const ty2 = ty + dy;
        if (ty2 < 0 || ty2 >= h) continue;
        for (let dx = -r; dx <= r; dx++) {
          const tx2 = tx + dx;
          if (tx2 < 0 || tx2 >= w) continue;
          const ti = ty2 * w + tx2;
          if (!known[ti]) continue;
          const si = ((sy + dy) * w + sx + dx) * 4, tj = ti * 4;
          const a = px[tj] - px[si], b = px[tj + 1] - px[si + 1], c = px[tj + 2] - px[si + 2], e = px[tj + 3] - px[si + 3];
          d += a * a + b * b + c * c + e * e;
          n++;
          if (d > cutoff * n) return Infinity;
        }
      }
      return n ? d / n : Infinity;
    };

    const iterations = li === 0 ? (opts.iterations ?? 4) : 6;
    const cost = new Float32Array(w * h).fill(Infinity);
    for (let it = 0; it < iterations; it++) {
      for (let i = 0; i < w * h; i++) if (target[i]) cost[i] = dist(i, field[i], Infinity);
      // PatchMatch: alternate scan order, propagate from neighbours, then random search
      for (let pass = 0; pass < 2; pass++) {
        const fwd = (it + pass) % 2 === 0;
        const step = fwd ? 1 : -1;
        for (let k = 0; k < w * h; k++) {
          const i = fwd ? k : w * h - 1 - k;
          if (!target[i]) continue;
          const x = i % w;
          let best = field[i], bestCost = cost[i];
          const tryS = (s) => {
            if (s < 0 || s >= w * h || !valid[s] || s === best) return;
            const c = dist(i, s, bestCost);
            if (c < bestCost) {
              bestCost = c;
              best = s;
            }
          };
          // propagation
          const nx = x - step;
          if (nx >= 0 && nx < w && target[i - step]) {
            const fs = field[i - step], fx = (fs % w) + step;
            if (fx >= 0 && fx < w) tryS(fs + step);
          }
          const ny = i - step * w;
          if (ny >= 0 && ny < w * h && target[ny]) tryS(field[ny] + step * w);
          // random search in shrinking windows
          let rad = Math.max(w, h);
          const bx = best % w, by = (best / w) | 0;
          while (rad >= 1) {
            const sx = Math.round(bx + (random() * 2 - 1) * rad), sy = Math.round(by + (random() * 2 - 1) * rad);
            if (sx >= 0 && sy >= 0 && sx < w && sy < h) tryS(sy * w + sx);
            rad >>= 1;
          }
          if (bestCost === Infinity) {
            // no known pixel in reach yet: any valid source will do
            best = validList[(random() * count) | 0];
          }
          field[i] = best;
          cost[i] = bestCost;
        }
      }
      // voting: every hole pixel averages the source pixels of the patches covering it
      const acc = new Float32Array(w * h * 5);
      let meanCost = 0, nCost = 0;
      for (let i = 0; i < w * h; i++) if (target[i] && cost[i] < Infinity) {
        meanCost += cost[i];
        nCost++;
      }
      meanCost = nCost ? meanCost / nCost : 1;
      for (let i = 0; i < w * h; i++) {
        if (!target[i]) continue;
        const wgt = Math.exp(-(cost[i] === Infinity ? meanCost * 4 : cost[i]) / (2 * meanCost + 1e-6));
        const tx = i % w, ty = (i / w) | 0, s = field[i], sx = s % w, sy = (s / w) | 0;
        for (let dy = -r; dy <= r; dy++) {
          const y = ty + dy;
          if (y < 0 || y >= h) continue;
          for (let dx = -r; dx <= r; dx++) {
            const x = tx + dx;
            if (x < 0 || x >= w) continue;
            const ti = y * w + x;
            if (!hole[ti]) continue;
            const si = ((sy + dy) * w + sx + dx) * 4;
            const o = ti * 5;
            acc[o] += px[si] * wgt;
            acc[o + 1] += px[si + 1] * wgt;
            acc[o + 2] += px[si + 2] * wgt;
            acc[o + 3] += px[si + 3] * wgt;
            acc[o + 4] += wgt;
          }
        }
      }
      for (let i = 0; i < w * h; i++) {
        if (!hole[i]) continue;
        const o = i * 5;
        if (acc[o + 4] > 0) {
          for (let c = 0; c < 4; c++) px[i * 4 + c] = acc[o + c] / acc[o + 4];
          known[i] = 1;
        }
      }
    }
    nnf = field;
  }

  // write the filled pixels back
  for (let y = 0; y < R.height; y++) {
    for (let x = 0; x < R.width; x++) {
      const i = y * R.width + x;
      if (!base.hole[i]) continue;
      const m = mask[(R.y + y) * W + R.x + x] / 255;
      const o = ((R.y + y) * W + R.x + x) * 4;
      for (let c = 0; c < 4; c++) img.data[o + c] = Math.round(img.data[o + c] + (base.px[i * 4 + c] - img.data[o + c]) * m);
    }
  }
  return img;
}
