// Mesh warps on ImageDataLike (see ARCHITECTURE.md "Warp"): a destination grid is resampled from a
// source grid with one affine inverse map per triangle (two per cell), so the only per-pixel work is
// a barycentric test and a bilinear/bicubic sample. On top of that: a bicubic Bézier patch (Free
// Transform › Warp), moving least squares (Puppet Warp) and perspective quads (Perspective Warp).
// Every warp returns { image, x, y }: the warped pixels and where their bounding box starts in the
// coordinate space of the grids (the image's pixel (0, 0) is at (0, 0) of that space).
import { createImage, intersectRect, isEmptyRect } from './core.js';
import { homography, applyHomography } from './transform.js';

/** @typedef {{ cols: number, rows: number, points: [number, number][] }} Grid  (cols+1)·(rows+1) points, row-major */

const EPS = 1e-6;

// ---- grids ------------------------------------------------------------------------------------------------------

/** Regular grid over rect with cols × rows cells. */
export function regularGrid(rect, cols, rows) {
  const points = new Array((cols + 1) * (rows + 1));
  for (let r = 0; r <= rows; r++) {
    const y = rect.y + (rect.height * r) / rows;
    for (let c = 0; c <= cols; c++) points[r * (cols + 1) + c] = [rect.x + (rect.width * c) / cols, y];
  }
  return { cols, rows, points };
}

/** Grid with the same topology whose points are fn(point, index). */
export function mapGrid(grid, fn) {
  return { cols: grid.cols, rows: grid.rows, points: grid.points.map((p, i) => fn(p, i)) };
}

export function gridBounds(grid) {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const [x, y] of grid.points) {
    if (x < x1) x1 = x;
    if (x > x2) x2 = x;
    if (y < y1) y1 = y;
    if (y > y2) y2 = y;
  }
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

function checkGrid(g, name) {
  if (!g || !Number.isInteger(g.cols) || !Number.isInteger(g.rows) || g.cols < 1 || g.rows < 1) throw new Error(`${name} grid needs at least one cell`);
  if (!Array.isArray(g.points) || g.points.length !== (g.cols + 1) * (g.rows + 1)) throw new Error(`${name} grid has ${g.points?.length} points, expected ${(g.cols + 1) * (g.rows + 1)}`);
}

// ---- samplers ---------------------------------------------------------------------------------------------------

const cubic = (x) => {
  // Catmull-Rom (a = -0.5), the kernel pixels/transform.js uses for bicubic
  const ax = Math.abs(x);
  if (ax < 1) return 1.5 * ax * ax * ax - 2.5 * ax * ax + 1;
  if (ax < 2) return -0.5 * ax * ax * ax + 2.5 * ax * ax - 4 * ax + 2;
  return 0;
};

/**
 * Returns sample(sx, sy, o): writes the source colour at a continuous position (pixel centres at
 * +0.5) into out.data at byte offset o. Interpolation weights colour by alpha (premultiplied) so
 * transparent neighbours never bleed dark fringes; outside the image is transparent.
 */
function makeSampler(img, out, interp) {
  const sd = img.data, od = out.data, w = img.width, h = img.height;
  if (interp === 'nearest') {
    return (sx, sy, o) => {
      const x = Math.floor(sx), y = Math.floor(sy);
      if (x < 0 || y < 0 || x >= w || y >= h) {
        od[o] = od[o + 1] = od[o + 2] = od[o + 3] = 0;
        return;
      }
      const p = (y * w + x) * 4;
      od[o] = sd[p];
      od[o + 1] = sd[p + 1];
      od[o + 2] = sd[p + 2];
      od[o + 3] = sd[p + 3];
    };
  }
  if (interp === 'bicubic') {
    return (sx, sy, o) => {
      const fx = sx - 0.5, fy = sy - 0.5;
      if (fx <= -2 || fy <= -2 || fx >= w + 1 || fy >= h + 1) {
        od[o] = od[o + 1] = od[o + 2] = od[o + 3] = 0;
        return;
      }
      const x0 = Math.floor(fx), y0 = Math.floor(fy);
      let r = 0, g = 0, b = 0, a = 0, wsum = 0;
      for (let j = -1; j <= 2; j++) {
        const yy = y0 + j;
        const wy = cubic(fy - yy);
        if (!wy) continue;
        const rowOut = yy < 0 || yy >= h;
        for (let i = -1; i <= 2; i++) {
          const xx = x0 + i;
          const wx = cubic(fx - xx);
          if (!wx) continue;
          const wgt = wx * wy;
          wsum += wgt;
          if (rowOut || xx < 0 || xx >= w) continue; // outside contributes transparent
          const p = (yy * w + xx) * 4;
          const wa = wgt * sd[p + 3];
          r += sd[p] * wa;
          g += sd[p + 1] * wa;
          b += sd[p + 2] * wa;
          a += wa;
        }
      }
      if (wsum && Math.abs(wsum - 1) > 1e-6) {
        r /= wsum;
        g /= wsum;
        b /= wsum;
        a /= wsum;
      }
      if (a <= 0.5) {
        od[o] = od[o + 1] = od[o + 2] = od[o + 3] = 0;
        return;
      }
      od[o] = r / a;
      od[o + 1] = g / a;
      od[o + 2] = b / a;
      od[o + 3] = a;
    };
  }
  // bilinear
  return (sx, sy, o) => {
    const fx = sx - 0.5, fy = sy - 0.5;
    if (fx <= -1 || fy <= -1 || fx >= w || fy >= h) {
      od[o] = od[o + 1] = od[o + 2] = od[o + 3] = 0;
      return;
    }
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const tx = fx - x0, ty = fy - y0;
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
        const wa = wgt * sd[p + 3];
        r += sd[p] * wa;
        g += sd[p + 1] * wa;
        b += sd[p + 2] * wa;
        a += wa;
      }
    }
    if (a <= 0.5) {
      od[o] = od[o + 1] = od[o + 2] = od[o + 3] = 0;
      return;
    }
    od[o] = r / a;
    od[o + 1] = g / a;
    od[o + 2] = b / a;
    od[o + 3] = a;
  };
}

// ---- mesh warp --------------------------------------------------------------------------------------------------

/**
 * Resamples img so that the cells of `src` land on the cells of `dst` (same topology; either may be
 * one Grid or an array of Grids, e.g. one per Perspective Warp quad). Each destination cell is split
 * into two triangles whose inverse maps are affine (barycentric in the destination triangle).
 * opts: { interp: 'nearest'|'bilinear'|'bicubic', clip: Rect | null (limits the output) }.
 * Returns { image, x, y } covering the bounding box of the destination grids (transparent outside).
 */
export function meshWarp(img, src, dst, { interp = 'bilinear', clip = null } = {}) {
  const srcs = Array.isArray(src) ? src : [src];
  const dsts = Array.isArray(dst) ? dst : [dst];
  if (srcs.length !== dsts.length) throw new Error('source and destination need the same number of grids');
  let bx1 = Infinity, by1 = Infinity, bx2 = -Infinity, by2 = -Infinity;
  for (let i = 0; i < srcs.length; i++) {
    checkGrid(srcs[i], 'source');
    checkGrid(dsts[i], 'destination');
    if (srcs[i].cols !== dsts[i].cols || srcs[i].rows !== dsts[i].rows) throw new Error('source and destination grids differ in size');
    const b = gridBounds(dsts[i]);
    bx1 = Math.min(bx1, b.x);
    by1 = Math.min(by1, b.y);
    bx2 = Math.max(bx2, b.x + b.width);
    by2 = Math.max(by2, b.y + b.height);
  }
  let bounds = { x: Math.floor(bx1 + 1e-9), y: Math.floor(by1 + 1e-9), width: 0, height: 0 };
  bounds.width = Math.ceil(bx2 - 1e-9) - bounds.x;
  bounds.height = Math.ceil(by2 - 1e-9) - bounds.y;
  if (clip) bounds = intersectRect(bounds, clip);
  if (isEmptyRect(bounds) || !Number.isFinite(bounds.width) || !Number.isFinite(bounds.height)) return { image: createImage(1, 1), x: 0, y: 0, empty: true };
  const W = bounds.width, H = bounds.height;
  const out = createImage(W, H);
  const sample = makeSampler(img, out, interp);
  const ox = bounds.x, oy = bounds.y;

  // one triangle: destination D0..D2 -> source S0..S2, barycentric coefficients are affine in (x, y)
  const tri = (D0, D1, D2, S0, S1, S2) => {
    const det = (D1[0] - D0[0]) * (D2[1] - D0[1]) - (D2[0] - D0[0]) * (D1[1] - D0[1]);
    if (Math.abs(det) < 1e-12) return; // degenerate (folded flat) triangle
    const a1 = (D2[1] - D0[1]) / det, b1 = -(D2[0] - D0[0]) / det;
    const c1 = -(a1 * D0[0] + b1 * D0[1]);
    const a2 = -(D1[1] - D0[1]) / det, b2 = (D1[0] - D0[0]) / det;
    const c2 = -(a2 * D0[0] + b2 * D0[1]);
    const sx1 = S1[0] - S0[0], sy1 = S1[1] - S0[1], sx2 = S2[0] - S0[0], sy2 = S2[1] - S0[1];
    const x0 = Math.max(0, Math.floor(Math.min(D0[0], D1[0], D2[0]) - ox));
    const x1 = Math.min(W - 1, Math.ceil(Math.max(D0[0], D1[0], D2[0]) - ox));
    const y0 = Math.max(0, Math.floor(Math.min(D0[1], D1[1], D2[1]) - oy));
    const y1 = Math.min(H - 1, Math.ceil(Math.max(D0[1], D1[1], D2[1]) - oy));
    for (let y = y0; y <= y1; y++) {
      const py = oy + y + 0.5;
      // l1, l2 along the scanline: start at x0 and step by a1 / a2 per pixel
      let l1 = a1 * (ox + x0 + 0.5) + b1 * py + c1;
      let l2 = a2 * (ox + x0 + 0.5) + b2 * py + c2;
      let o = (y * W + x0) * 4;
      for (let x = x0; x <= x1; x++, l1 += a1, l2 += a2, o += 4) {
        const l0 = 1 - l1 - l2;
        if (l0 < -EPS || l1 < -EPS || l2 < -EPS) continue;
        sample(S0[0] + l1 * sx1 + l2 * sx2, S0[1] + l1 * sy1 + l2 * sy2, o);
      }
    }
  };

  for (let g = 0; g < srcs.length; g++) {
    const sg = srcs[g], dg = dsts[g];
    const stride = sg.cols + 1;
    const sp = sg.points, dp = dg.points;
    for (let r = 0; r < sg.rows; r++) {
      for (let c = 0; c < sg.cols; c++) {
        const i00 = r * stride + c, i10 = i00 + 1, i01 = i00 + stride, i11 = i01 + 1;
        tri(dp[i00], dp[i10], dp[i11], sp[i00], sp[i10], sp[i11]);
        tri(dp[i00], dp[i11], dp[i01], sp[i00], sp[i11], sp[i01]);
      }
    }
  }
  return { image: out, x: bounds.x, y: bounds.y };
}

// ---- Bézier patch (Free Transform › Warp) ---------------------------------------------------------------------

/** The 16 control points (row-major, 4 rows × 4 columns) of an undeformed patch over rect. */
export function identityControls(rect) {
  const pts = [];
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) pts.push([rect.x + (rect.width * j) / 3, rect.y + (rect.height * i) / 3]);
  return pts;
}

const bernstein = (t) => {
  const s = 1 - t;
  return [s * s * s, 3 * t * s * s, 3 * t * t * s, t * t * t];
};

/** Point of the bicubic Bézier patch at (u, v) in 0..1 (u along columns, v along rows). */
export function bezierPoint(controls, u, v, out = [0, 0]) {
  const bu = bernstein(u), bv = bernstein(v);
  let x = 0, y = 0;
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      const w = bv[i] * bu[j];
      const p = controls[i * 4 + j];
      x += p[0] * w;
      y += p[1] * w;
    }
  }
  out[0] = x;
  out[1] = y;
  return out;
}

/** Source (regular) and destination (patch) grids with n × n cells over rect. */
export function bezierGrids(rect, controls, n = 16) {
  if (!Array.isArray(controls) || controls.length !== 16) throw new Error('a warp patch needs 16 control points');
  const src = regularGrid(rect, n, n);
  const dst = mapGrid(src, (p, i) => bezierPoint(controls, (i % (n + 1)) / n, Math.floor(i / (n + 1)) / n));
  return { src, dst };
}

/** Warps the part of img under rect through a bicubic Bézier patch (16 control points, row-major). */
export function bezierWarp(img, rect, controls, { subdivisions = 16, interp = 'bilinear', clip = null } = {}) {
  const { src, dst } = bezierGrids(rect, controls, Math.max(1, Math.round(subdivisions)));
  return meshWarp(img, src, dst, { interp, clip });
}

// ---- moving least squares (Puppet Warp) ------------------------------------------------------------------------

/**
 * Deformed position of v under pins { from: [x, y], to: [x, y] }[] (Schaefer, McPhail, Warren 2006).
 * kind: 'rigid' (no stretching) | 'similarity' (uniform scale allowed) | 'affine'. alpha weights the
 * pins by 1 / distance^(2·alpha). Zero pins is the identity; one pin is a translation.
 */
export function mlsPoint(pins, v, { kind = 'rigid', alpha = 1 } = {}, out = [0, 0]) {
  const n = pins.length;
  const vx = v[0], vy = v[1];
  if (n === 0) {
    out[0] = vx;
    out[1] = vy;
    return out;
  }
  if (n === 1) {
    out[0] = vx + pins[0].to[0] - pins[0].from[0];
    out[1] = vy + pins[0].to[1] - pins[0].from[1];
    return out;
  }
  // weights and the weighted centroids
  let wsum = 0, pcx = 0, pcy = 0, qcx = 0, qcy = 0;
  const ws = mlsScratch(n);
  for (let i = 0; i < n; i++) {
    const p = pins[i].from, q = pins[i].to;
    const dx = p[0] - vx, dy = p[1] - vy;
    const d2 = dx * dx + dy * dy;
    if (d2 < 1e-9) {
      out[0] = q[0];
      out[1] = q[1];
      return out; // exactly on a pin
    }
    const w = alpha === 1 ? 1 / d2 : 1 / Math.pow(d2, alpha);
    ws[i] = w;
    wsum += w;
    pcx += w * p[0];
    pcy += w * p[1];
    qcx += w * q[0];
    qcy += w * q[1];
  }
  pcx /= wsum;
  pcy /= wsum;
  qcx /= wsum;
  qcy /= wsum;
  const dx = vx - pcx, dy = vy - pcy;
  if (kind === 'affine') {
    // M = (Σ w p̂ᵀ p̂)⁻¹ (Σ w p̂ᵀ q̂), f(v) = (v − p*) M + q*
    let m00 = 0, m01 = 0, m11 = 0, n00 = 0, n01 = 0, n10 = 0, n11 = 0;
    for (let i = 0; i < n; i++) {
      const w = ws[i];
      const px = pins[i].from[0] - pcx, py = pins[i].from[1] - pcy;
      const qx = pins[i].to[0] - qcx, qy = pins[i].to[1] - qcy;
      m00 += w * px * px;
      m01 += w * px * py;
      m11 += w * py * py;
      n00 += w * px * qx;
      n01 += w * px * qy;
      n10 += w * py * qx;
      n11 += w * py * qy;
    }
    const det = m00 * m11 - m01 * m01;
    if (Math.abs(det) > 1e-9 * (m00 + m11 + 1e-30) ** 2) {
      const i00 = m11 / det, i01 = -m01 / det, i11 = m00 / det;
      const a = i00 * n00 + i01 * n10, b = i00 * n01 + i01 * n11;
      const c = i01 * n00 + i11 * n10, d = i01 * n01 + i11 * n11;
      out[0] = dx * a + dy * c + qcx;
      out[1] = dx * b + dy * d + qcy;
      return out;
    }
    // collinear pins: the affine system is singular, a similarity is the closest well-posed answer
  }
  // similarity / rigid: Σ q̂ᵢ Aᵢ with Aᵢ = wᵢ [p̂ᵢ; −p̂ᵢ⊥] [v−p*; −(v−p*)⊥]ᵀ
  let rx = 0, ry = 0, mu = 0;
  for (let i = 0; i < n; i++) {
    const w = ws[i];
    const px = pins[i].from[0] - pcx, py = pins[i].from[1] - pcy;
    const qx = pins[i].to[0] - qcx, qy = pins[i].to[1] - qcy;
    mu += w * (px * px + py * py);
    const t00 = px * dx + py * dy, t01 = px * dy - py * dx; // [p̂; −p̂⊥] · [d; −d⊥]ᵀ
    rx += w * (qx * t00 - qy * t01);
    ry += w * (qx * t01 + qy * t00);
  }
  if (kind === 'rigid') {
    const len = Math.hypot(dx, dy), norm = Math.hypot(rx, ry);
    if (norm < 1e-12 || mu < 1e-12) {
      out[0] = dx + qcx;
      out[1] = dy + qcy;
      return out;
    }
    out[0] = (rx * len) / norm + qcx;
    out[1] = (ry * len) / norm + qcy;
    return out;
  }
  if (mu < 1e-12) {
    out[0] = dx + qcx;
    out[1] = dy + qcy;
    return out;
  }
  out[0] = rx / mu + qcx;
  out[1] = ry / mu + qcy;
  return out;
}

let scratch = new Float64Array(16);
function mlsScratch(n) {
  if (scratch.length < n) scratch = new Float64Array(n * 2);
  return scratch;
}

/** Source grid on a step-px lattice over rect and its MLS image. */
export function mlsGrids(rect, pins, { kind = 'rigid', alpha = 1, step = 4 } = {}) {
  const s = Math.max(1, step);
  const cols = Math.max(1, Math.ceil(rect.width / s)), rows = Math.max(1, Math.ceil(rect.height / s));
  const points = new Array((cols + 1) * (rows + 1));
  for (let r = 0; r <= rows; r++) {
    const y = rect.y + Math.min(r * s, rect.height);
    for (let c = 0; c <= cols; c++) points[r * (cols + 1) + c] = [rect.x + Math.min(c * s, rect.width), y];
  }
  const src = { cols, rows, points };
  const opts = { kind, alpha };
  const dst = mapGrid(src, (p) => mlsPoint(pins, p, opts, [0, 0]));
  return { src, dst };
}

/**
 * Moving-least-squares warp of img (or of `rect` inside it) driven by pins { from, to }[] in image
 * coordinates: the lattice points step px apart are deformed with mlsPoint, then meshWarp'ed.
 */
export function mlsWarp(img, pins, { kind = 'rigid', alpha = 1, step = 4, interp = 'bilinear', rect = null, clip = null } = {}) {
  const r = rect ?? { x: 0, y: 0, width: img.width, height: img.height };
  const { src, dst } = mlsGrids(r, pins, { kind, alpha, step });
  return meshWarp(img, src, dst, { interp, clip });
}

// ---- perspective quads (Perspective Warp) ----------------------------------------------------------------------

/**
 * Builds one grid pair per quad { src: Quad, dst: Quad } (corners tl, tr, br, bl). Destination points
 * are bilinear in the destination quad, so quads sharing an edge produce identical points along it
 * (no cracks); source points are their pre-image under the quad's homography, so the per-triangle
 * affine maps approximate the true perspective to sub-pixel accuracy at `subdivisions` ≥ 8.
 */
export function perspectiveMesh(quads, { subdivisions = 12 } = {}) {
  const n = Math.max(1, Math.round(subdivisions));
  const src = [], dst = [];
  for (const q of quads) {
    const Hd2s = homography(q.dst, q.src); // destination -> source
    const [tl, tr, br, bl] = q.dst;
    const dpts = [], spts = [];
    for (let r = 0; r <= n; r++) {
      const v = r / n;
      for (let c = 0; c <= n; c++) {
        const u = c / n;
        const topX = tl[0] + (tr[0] - tl[0]) * u, topY = tl[1] + (tr[1] - tl[1]) * u;
        const botX = bl[0] + (br[0] - bl[0]) * u, botY = bl[1] + (br[1] - bl[1]) * u;
        const d = [topX + (botX - topX) * v, topY + (botY - topY) * v];
        dpts.push(d);
        spts.push(applyHomography(Hd2s, d[0], d[1]));
      }
    }
    src.push({ cols: n, rows: n, points: spts });
    dst.push({ cols: n, rows: n, points: dpts });
  }
  return { src, dst };
}

/** Warps img so that each source quad lands on its destination quad (pixels outside every quad are dropped). */
export function perspectiveWarp(img, quads, { subdivisions = 12, interp = 'bilinear', clip = null } = {}) {
  const { src, dst } = perspectiveMesh(quads, { subdivisions });
  return meshWarp(img, src, dst, { interp, clip });
}
