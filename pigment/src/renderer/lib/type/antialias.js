// Anti-aliasing methods of text (0.5, type-menu-commands; ARCHITECTURE.md "0.5 features", S11.3, S11.4).
//
// typeOptions.antiAlias is one of None, Sharp, Crisp, Strong, Smooth, Windows LCD, Windows. Smooth is the engine's own
// drawing (Canvas 2D's anti-aliasing); Windows LCD is drawn as Smooth and Windows as Sharp (Pigment draws greyscale
// coverage, not sub-pixel colour). The other four are drawn by the text render stage `anti-alias` (order 200,
// `transformed`): the glyph outlines (lib/type/outlines.js), mapped by the stages below it (Warp Text's geometry) and
// the layer's transform matrix, are rasterised here with an exact area-coverage rasteriser, and each method shapes
// that coverage:
//   None    a pixel is in when at least half of it is covered: only 0 and 255 alpha;
//   Sharp   a steep ramp around half coverage (edges one pixel wide at most);
//   Crisp   a gentler ramp;
//   Strong  the ramp moved toward lower coverage, so strokes look heavier.
// These are approximations of Photoshop's methods, which are not documented. Text whose runs draw strokes or faux bold
// is drawn by Canvas 2D from the same mapped outlines and its coverage shaped afterwards; text without outlines (the
// Canvas engine, colour glyphs, characters the browser's fallback draws) shapes the engine's own drawing, resampled
// through the matrix first. Text on a path keeps the engine's drawing (the stage leaves text extensions alone, S11.3).
//
// The rasteriser and the coverage curves are pure and run in Node (tests/unit/type-menu-commands.test.mjs).
import { registerTextRenderStage, stageGeometry } from './api.js';
import { layerOutlines, mappedPolygons, polygonsBounds, paintOutlines } from './outlines.js';
import { createCanvas } from '../document.js';
import { parseColor, rgbaToHex } from '../../../shared/pixels/color.js';

/** The methods the stage draws (Smooth and Windows LCD are the engine's own drawing). */
export const STAGE_METHODS = Object.freeze(['none', 'sharp', 'crisp', 'strong', 'windows']);

// ---- coverage -----------------------------------------------------------------------------------------------------

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** The coverage curve of a method: coverage 0..1 -> alpha 0..1. */
export function coverageCurve(method) {
  switch (method) {
    case 'none': return (c) => (c >= 0.5 ? 1 : 0);
    case 'sharp':
    case 'windows': return (c) => clamp01((c - 0.5) * 3 + 0.5);
    case 'crisp': return (c) => clamp01((c - 0.5) * 1.8 + 0.5);
    case 'strong': return (c) => clamp01((c - 0.5) * 1.6 + 0.7);
    default: return (c) => clamp01(c);
  }
}

/** The curve as a 256-entry table over 8-bit alpha (shaping a drawing that already has its coverage in alpha). */
export function alphaTable(method) {
  const f = coverageCurve(method);
  const t = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i++) t[i] = Math.round(f(i / 255) * 255);
  return t;
}

/**
 * Exact area coverage of closed polygons (each a flat [x0, y0, x1, y1, ...] array in pixel units, the pixel (i, j)
 * covering [i, i+1) × [j, j+1)) over a width × height grid, nonzero-like: the signed areas of the contours add up and
 * the magnitude is clamped to 1, so a hole wound against its contour is empty and overlapping contours stay full.
 * Each edge adds its signed area to an accumulation row (the method of font-rs); a running sum along each row gives the
 * coverage. Returns a Float32Array of width × height.
 */
export function rasterizeCoverage(polys, width, height) {
  const stride = width + 2;
  const acc = new Float32Array(stride * height);
  const line = (x0, y0, x1, y1) => {
    if (y0 === y1) return;
    let dir = 1;
    if (y0 > y1) {
      [x0, x1] = [x1, x0];
      [y0, y1] = [y1, y0];
      dir = -1;
    }
    const dxdy = (x1 - x0) / (y1 - y0);
    let yA = y0, x = x0;
    if (yA < 0) {
      x -= yA * dxdy;
      yA = 0;
    }
    const yB = Math.min(height, y1);
    if (yA >= yB) return;
    for (let y = Math.floor(yA); y < yB; y++) {
      const ls = y * stride;
      const dy = Math.min(y + 1, yB) - Math.max(y, yA);
      const xnext = x + dxdy * dy;
      const d = dy * dir;
      let xa = x < xnext ? x : xnext, xb = x < xnext ? xnext : x;
      // left of the grid every pixel to the right is covered: column 0 takes it; right of it nothing shows
      if (xa < 0) xa = 0;
      if (xb < 0) xb = 0;
      if (xa > width) xa = width;
      if (xb > width) xb = width;
      const x0f = Math.floor(xa), x0i = x0f | 0;
      const x1c = Math.ceil(xb), x1i = x1c | 0;
      if (x1i <= x0i + 1) {
        const xmf = 0.5 * (xa + xb) - x0f;
        acc[ls + x0i] += d - d * xmf;
        acc[ls + x0i + 1] += d * xmf;
      } else {
        const s = 1 / (xb - xa);
        const fa = xa - x0f;
        const a0 = 0.5 * s * (1 - fa) * (1 - fa);
        const fb = xb - x1c + 1;
        const am = 0.5 * s * fb * fb;
        acc[ls + x0i] += d * a0;
        if (x1i === x0i + 2) acc[ls + x0i + 1] += d * (1 - a0 - am);
        else {
          const a1 = s * (1.5 - fa);
          acc[ls + x0i + 1] += d * (a1 - a0);
          for (let xi = x0i + 2; xi < x1i - 1; xi++) acc[ls + xi] += d * s;
          const a2 = a1 + (x1i - x0i - 3) * s;
          acc[ls + x1i - 1] += d * (1 - a2 - am);
        }
        acc[ls + x1i] += d * am;
      }
      x = xnext;
    }
  };
  for (const p of polys) {
    const n = p.length;
    if (n < 6) continue;
    for (let i = 0; i < n; i += 2) {
      const j = i + 2 < n ? i + 2 : 0;
      line(p[i], p[i + 1], p[j], p[j + 1]);
    }
  }
  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    let sum = 0;
    const ls = y * stride, o = y * width;
    for (let x = 0; x < width; x++) {
      sum += acc[ls + x];
      const a = sum < 0 ? -sum : sum;
      out[o + x] = a > 1 ? 1 : a;
    }
  }
  return out;
}

/**
 * Composites one colour through shaped coverage onto straight RGBA (source over). `cov` covers the box (bx, by, bw,
 * bh) of the `data` grid of width `w`; `rgba` is [r, g, b, a] with a in 0..1.
 */
export function compositeCoverage(data, w, cov, bx, by, bw, bh, rgba, curve) {
  const [r, g, b, ca] = rgba;
  for (let y = 0; y < bh; y++) {
    let o = ((by + y) * w + bx) * 4;
    let k = y * bw;
    for (let x = 0; x < bw; x++, o += 4, k++) {
      const c = cov[k];
      if (c <= 0) continue;
      const sa = curve(c) * ca;
      if (sa <= 0) continue;
      const da = data[o + 3] / 255;
      const oa = sa + da * (1 - sa);
      const kd = (da * (1 - sa)) / oa, ks = sa / oa;
      data[o] = r * ks + data[o] * kd;
      data[o + 1] = g * ks + data[o + 1] * kd;
      data[o + 2] = b * ks + data[o + 2] * kd;
      data[o + 3] = oa * 255;
    }
  }
}

/** Shapes the alpha of straight RGBA in place through a method's table. */
export function shapeAlpha(data, method) {
  const t = alphaTable(method);
  for (let i = 3; i < data.length; i += 4) data[i] = t[data[i]];
}

// ---- the render stage ---------------------------------------------------------------------------------------------

const colorOf = (st) => rgbaToHex(parseColor(st.color), true);
const rgbaOf = (st) => {
  const c = parseColor(st.color);
  return [c[0], c[1], c[2], c[3] ?? 1];
};
const methodOf = (layer) => layer?.typeOptions?.antiAlias ?? 'smooth';
const isAffineIdentity = (m) => !m || (m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && m[4] === 0 && m[5] === 0);

/** { canvas, x, y } of a base-space render resampled through a matrix (TextLayer.render's resampling). */
function resample(base, m) {
  const corners = [[base.x, base.y], [base.x + base.canvas.width, base.y], [base.x, base.y + base.canvas.height], [base.x + base.canvas.width, base.y + base.canvas.height]].map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]);
  const xs = corners.map((c) => c[0]), ys = corners.map((c) => c[1]);
  const x = Math.floor(Math.min(...xs)), y = Math.floor(Math.min(...ys));
  const canvas = createCanvas(Math.max(1, Math.ceil(Math.max(...xs)) - x), Math.max(1, Math.ceil(Math.max(...ys)) - y));
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.setTransform(m[0], m[1], m[2], m[3], m[4] - x, m[5] - y);
  ctx.drawImage(base.canvas, base.x, base.y);
  return { canvas, x, y };
}

/** A copy of a render with its alpha shaped by the method. */
function shaped(src, method) {
  const w = src.canvas.width, h = src.canvas.height;
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(src.canvas, 0, 0);
  const img = ctx.getImageData(0, 0, w, h);
  shapeAlpha(img.data, method);
  ctx.putImageData(img, 0, 0);
  return { canvas, x: src.x, y: src.y };
}

/**
 * Draws a text layer's outlines with a method: base space through `geometry` (the stages below, or null) and the
 * matrix (or none) into a canvas of the mapped bounds. Returns { canvas, x, y } or null when there is nothing to draw.
 */
export function drawWithMethod(ol, method, { geometry = null, matrix = null } = {}) {
  const m = matrix && !isAffineIdentity(matrix) ? matrix : null;
  const map = geometry || m ? (x, y) => {
    let p = geometry ? geometry.mapPoint(x, y) : [x, y];
    if (m) p = [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]];
    return p;
  } : null;
  const scale = m ? Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1 : 1;
  const tol = 0.15 / Math.max(1e-3, scale);
  const maxSeg = geometry ? 3 : Infinity;
  const runs = ol.runs.map((r) => ({ r, glyphs: mappedPolygons(r.subpaths, map, { tol, maxSeg }), decos: mappedPolygons(r.decorations, map, { tol, maxSeg }) }));
  let pad = 1;
  for (const { r } of runs) pad = Math.max(pad, ((r.stroke?.width ?? 0) + (r.bold ? r.style.size / 30 : 0)) * scale + 1);
  const all = runs.flatMap((x) => [...x.glyphs, ...x.decos]);
  const bb = polygonsBounds(all);
  if (!bb) return null;
  const x0 = Math.floor(bb.x1 - pad), y0 = Math.floor(bb.y1 - pad);
  const w = Math.max(1, Math.ceil(bb.x2 + pad) - x0), h = Math.max(1, Math.ceil(bb.y2 + pad) - y0);
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  if (ol.runs.some((r) => r.stroke || r.bold)) {
    // strokes need Canvas 2D: draw smooth from the same mapped outlines, then shape the coverage
    paintOutlines(ctx, ol, (x, y) => {
      const p = map ? map(x, y) : [x, y];
      return [p[0] - x0, p[1] - y0];
    }, { scale, tol, maxSeg, colorOf });
    const img = ctx.getImageData(0, 0, w, h);
    shapeAlpha(img.data, method);
    ctx.putImageData(img, 0, 0);
    return { canvas, x: x0, y: y0 };
  }
  const img = ctx.createImageData(w, h);
  const curve = coverageCurve(method);
  for (const { r, glyphs, decos } of runs) {
    const polys = [...glyphs, ...decos];
    const rb = polygonsBounds(polys);
    if (!rb) continue;
    const bx = Math.max(0, Math.floor(rb.x1) - x0), by = Math.max(0, Math.floor(rb.y1) - y0);
    const bw = Math.min(w, Math.ceil(rb.x2) - x0 + 1) - bx, bh = Math.min(h, Math.ceil(rb.y2) - y0 + 1) - by;
    if (bw <= 0 || bh <= 0) continue;
    const shift = (list) => list.map((p) => {
      const q = new Float64Array(p.length);
      for (let i = 0; i < p.length; i += 2) {
        q[i] = p[i] - x0 - bx;
        q[i + 1] = p[i + 1] - y0 - by;
      }
      return q;
    });
    // glyphs and decorations apart (a rectangle crossing a descender would cancel it), joined by their sum
    const cov = rasterizeCoverage(shift(glyphs), bw, bh);
    if (decos.length) {
      const dc = rasterizeCoverage(shift(decos), bw, bh);
      for (let i = 0; i < cov.length; i++) cov[i] = Math.min(1, cov[i] + dc[i]);
    }
    compositeCoverage(img.data, w, cov, bx, by, bw, bh, rgbaOf(r.style), curve);
  }
  ctx.putImageData(img, 0, 0);
  return { canvas, x: x0, y: y0 };
}

/** Registers the `anti-alias` text render stage (S11.3). Returns its unregister function. */
export function installAntiAlias(app) {
  return registerTextRenderStage({
    id: 'anti-alias',
    order: 200,
    transformed: true,
    // the method holds while the text is edited, so typing does not change its look
    whileEditing: 'apply',
    test: (layer) => STAGE_METHODS.includes(methodOf(layer)),
    render(layer, next, layout, { matrix }) {
      const method = methodOf(layer);
      // type-fonts' hover preview (a stage below) draws another font in this layer's place: shape what it drew
      const previewing = app.fontPicker?.preview?.layers?.includes?.(layer);
      const ol = previewing ? null : layerOutlines(layer);
      if (ol?.complete) {
        const out = drawWithMethod(ol, method, { geometry: stageGeometry(layer, 200), matrix });
        if (out) return out;
      }
      const base = next();
      const m = matrix && !isAffineIdentity(matrix) ? matrix : null;
      // a copy (never next()'s own object): with a matrix it is in document space, which renderText marks
      return shaped(m && !base.transformed ? resample(base, m) : base, method);
    },
  });
}
