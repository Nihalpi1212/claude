// Lens Correction (builder "content-aware-lens"): Filter > Lens Correction… as one filter kind whose
// params hold the Custom tab's controls, so smart filters and actions re-run it from params (the dialog in
// lib/lens-correction.js registers a custom opener). Pure, no DOM.
//
// Every destination pixel is mapped back into the source (inverse mapping, bilinear, alpha weighted):
//
//   destination --1/scale--> --perspective^-1--> --rotate^-1--> corrected image --radial model--> source
//
// - Geometric distortion is radial on the radius normalised by the half diagonal (r = 1 at the corners):
//   g(r) = r (1 + k1 r² + k2 r⁴) / (1 + k1 + k2), so the corners stay where they are (Photoshop's framing).
//   A negative amount reads the source at g(r): the picture bulges (barrel), which straightens a pincushion
//   photo. A positive amount reads it at g⁻¹(r): the picture is pinched (pincushion), which straightens a
//   barrel photo and leaves empty areas along the edges. The two are exact inverses of each other, so
//   +n followed by -n gives the image back.
// - Chromatic aberration is a magnification difference between the channels: red, green and blue are read
//   at slightly different radii (the fringe sliders move one channel against the others).
// - Vignette is a gain 1 + v (r / rmax)^p on the colour at the source radius; the midpoint sets p (2 at 50:
//   lower spreads the falloff towards the centre, higher keeps it in the corners).
// - Transform: rotate by `angle` (clockwise, so 90 is rotate90), then keystone (a homography that keeps the
//   centre: positive vertical widens the bottom, positive horizontal makes the right side taller), then scale.
// - `edge` says what the areas outside the source become; `autoScale` multiplies the scale by the smallest
//   factor that leaves no such area.
//
// detectHorizon() finds the dominant near-horizontal line (Hough transform on edge pixels, refined by a line
// fit) for "Straighten horizon"; straightenAngle() and gridLines() serve the dialog's straighten tool and grid.

import { parseColor } from './color.js';
import { defineFilter, num, clampNum, round8, region, isEmptyRegion, merge, DEG } from './filter-def.js';

/** @typedef {import('./core.js').ImageDataLike} ImageDataLike */
/** @typedef {import('./core.js').Rect} Rect */

export const LENS_DEFAULTS = Object.freeze({
  distortion: 0, // -100..100 (negative = barrel correction of pincushion, Photoshop's sign)
  chromaRC: 0, // red/cyan fringe, -100..100
  chromaBY: 0, // blue/yellow fringe, -100..100
  chromaGM: 0, // green/magenta fringe, -100..100
  vignette: 0, // -100..100 (negative darkens the corners)
  vignetteMidpoint: 50, // 0..100
  vertical: 0, // perspective, -100..100
  horizontal: 0,
  angle: 0, // degrees, clockwise
  scale: 100, // 50..150 %
  edge: 'transparent', // 'transparent' | 'repeat' | 'wrap' | 'background'
  autoScale: false,
  background: '#ffffff', // the colour of edge 'background' (the dialog stores the current background colour)
});

/** k1 and k2 of the radial model at an amount of 100 (k2 grows with the square, so small amounts stay a pure r² model). */
const K1 = 0.4, K2 = 0.1;
/** Relative magnification of a channel at a fringe amount of 100 (1 % of the radius: 12 px in the corners of a 2000x1500 image). */
const CHROMA = 0.01;
/** Keystone strength at 100: the far side is scaled by 1 / (1 - K), the near side by 1 / (1 + K). */
const KEYSTONE = 0.4;
/** The radial tables cover normalised radii 0..TABLE_R in TABLE_N steps (beyond that the model is evaluated directly). */
const TABLE_R = 4, TABLE_N = 4096;
const AUTO_SCALE_MAX = 8;

const EDGE_TRANSPARENT = 0, EDGE_REPEAT = 1, EDGE_WRAP = 2, EDGE_BACKGROUND = 3;
const edgeMode = (v) => (v === 'repeat' ? EDGE_REPEAT : v === 'wrap' ? EDGE_WRAP : v === 'background' ? EDGE_BACKGROUND : EDGE_TRANSPARENT);

/** Params with every number finite and inside its range. */
function normalize(params) {
  const p = merge(LENS_DEFAULTS, params);
  const n = (key, lo, hi) => clampNum(num(Number(p[key]), LENS_DEFAULTS[key]), lo, hi);
  return {
    distortion: n('distortion', -100, 100),
    chromaRC: n('chromaRC', -100, 100),
    chromaBY: n('chromaBY', -100, 100),
    chromaGM: n('chromaGM', -100, 100),
    vignette: n('vignette', -100, 100),
    vignetteMidpoint: n('vignetteMidpoint', 0, 100),
    vertical: n('vertical', -100, 100),
    horizontal: n('horizontal', -100, 100),
    angle: n('angle', -360, 360),
    scale: n('scale', 10, 400),
    edge: p.edge,
    autoScale: !!p.autoScale,
    background: p.background,
  };
}

/** g(r) of the radial model for an amount 0..1 (see the top of the file). */
function radialModel(amount) {
  const k1 = K1 * amount, k2 = K2 * amount * amount, norm = 1 + k1 + k2;
  const g = (r) => (r * (1 + k1 * r * r + k2 * r * r * r * r)) / norm;
  const dg = (r) => (1 + 3 * k1 * r * r + 5 * k2 * r * r * r * r) / norm;
  /** g⁻¹ by Newton's method (g is increasing and convex for r >= 0, so the iteration from above converges). */
  const inverse = (y) => {
    let r = y > 1 ? y : y * norm; // g(r) <= r below the corners, so y * norm is at or above the root there
    for (let i = 0; i < 24; i++) {
      const step = (g(r) - y) / dg(r);
      r -= step;
      if (Math.abs(step) < 1e-12) break;
    }
    return r;
  };
  return { g, inverse, norm };
}

/**
 * The destination -> source mapping of an image size and params. `scale` overrides the scale factor (the
 * auto scale search probes several). map(x, y, out) takes a destination point in pixel coordinates (pixel
 * centres at +0.5) and writes the source point of the green channel into out[0..1]; it returns false when
 * the point lies behind the keystone's horizon. radial(rn) is the factor source radius / corrected radius.
 */
function createMapping(width, height, p, scale = null) {
  const cx = width / 2, cy = height / 2;
  const R = Math.hypot(cx, cy) || 1;
  const d = p.distortion / 100;
  const model = d !== 0 ? radialModel(Math.abs(d)) : null;
  const factorAt = !model ? () => 1 : d < 0 ? (rn) => (rn > 0 ? model.g(rn) / rn : 1 / model.norm) : (rn) => (rn > 0 ? model.inverse(rn) / rn : model.norm);
  let table = null;
  if (model) {
    table = new Float64Array(TABLE_N + 2);
    for (let i = 0; i <= TABLE_N + 1; i++) table[i] = factorAt((i / TABLE_N) * TABLE_R);
  }
  const radial = !table ? () => 1 : (rn) => {
    if (rn >= TABLE_R) return factorAt(rn);
    const t = (rn / TABLE_R) * TABLE_N, i = t | 0;
    return table[i] + (table[i + 1] - table[i]) * (t - i);
  };
  const s = scale ?? p.scale / 100;
  // multiples of 90° are exact, so a quarter turn moves whole pixels
  const quarter = Math.round(p.angle / 90);
  const exact = Math.abs(p.angle - quarter * 90) < 1e-9;
  const cos = exact ? [1, 0, -1, 0][((quarter % 4) + 4) % 4] : Math.cos(p.angle * DEG);
  const sin = exact ? [0, 1, 0, -1][((quarter % 4) + 4) % 4] : Math.sin(p.angle * DEG);
  const kx = (KEYSTONE * p.horizontal) / 100 / (cx || 1), ky = (KEYSTONE * p.vertical) / 100 / (cy || 1);
  const affine = s !== 1 || cos !== 1 || kx !== 0 || ky !== 0;
  const map = (x, y, out) => {
    let X = x - cx, Y = y - cy;
    if (affine) {
      X /= s;
      Y /= s;
      const den = 1 + kx * X + ky * Y;
      if (den <= 1e-6) return false;
      X /= den;
      Y /= den;
      const xr = X * cos + Y * sin;
      Y = Y * cos - X * sin;
      X = xr;
    }
    if (table) {
      const f = radial(Math.sqrt(X * X + Y * Y) / R);
      X *= f;
      Y *= f;
    }
    out[0] = cx + X;
    out[1] = cy + Y;
    return true;
  };
  return { map, radial, cx, cy, R, geometric: affine || !!table };
}

/** Largest relative magnification of a channel (the auto scale must keep the outermost one inside). */
const chromaMax = (p) => 1 + CHROMA * Math.max(0, p.chromaRC, p.chromaBY, p.chromaGM) / 100;

/**
 * The smallest scale factor (>= 1, at most 8) by which the corrected image has to be enlarged so that no
 * destination pixel reads outside the source: what "Auto Scale Image" multiplies the scale with.
 * The scale itself is not part of the search (params.scale is ignored).
 */
export function autoScaleFactor(width, height, params) {
  const p = normalize(params);
  if (width < 2 || height < 2) return 1;
  const cm = chromaMax(p);
  const out = [0, 0];
  const STEPS = 48;
  // every pixel centre of the border must read between the first and the last pixel centre of the source
  const fits = (s) => {
    const m = createMapping(width, height, p, s);
    const inside = (x, y) => {
      if (!m.map(x, y, out)) return false;
      const sx = (out[0] - m.cx) * cm, sy = (out[1] - m.cy) * cm;
      return Math.abs(sx) <= m.cx - 0.5 + 1e-6 && Math.abs(sy) <= m.cy - 0.5 + 1e-6;
    };
    for (let i = 0; i <= STEPS; i++) {
      const x = 0.5 + ((width - 1) * i) / STEPS, y = 0.5 + ((height - 1) * i) / STEPS;
      if (!inside(x, 0.5) || !inside(x, height - 0.5) || !inside(0.5, y) || !inside(width - 0.5, y)) return false;
    }
    return true;
  };
  if (fits(1)) return 1;
  if (!fits(AUTO_SCALE_MAX)) return AUTO_SCALE_MAX;
  let lo = 1, hi = AUTO_SCALE_MAX;
  for (let i = 0; i < 40 && hi - lo > 1e-5; i++) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) hi = mid;
    else lo = mid;
  }
  return hi;
}

/** The scale factor a run uses: scale % times the auto scale factor when that is on. */
export function effectiveScale(width, height, params) {
  const p = normalize(params);
  return (p.scale / 100) * (p.autoScale ? autoScaleFactor(width, height, p) : 1);
}

/** Vignette gain per normalised source radius, as a table like the radial one (null when the amount is 0). */
function vignetteTable(p) {
  if (!p.vignette) return null;
  const v = p.vignette / 100;
  const power = 2 * Math.pow(4, (p.vignetteMidpoint - 50) / 50); // 0.5 .. 2 .. 8
  const t = new Float64Array(TABLE_N + 2);
  for (let i = 0; i <= TABLE_N + 1; i++) t[i] = clampNum(1 + v * Math.pow((i / TABLE_N) * TABLE_R, power), 0, 8);
  return t;
}

/** The gain the vignette applies at a normalised radius (0 = centre, 1 = corner): exported for tests and the dialog. */
export function vignetteGain(params, rn) {
  const p = normalize(params);
  if (!p.vignette) return 1;
  return clampNum(1 + (p.vignette / 100) * Math.pow(Math.max(0, rn), 2 * Math.pow(4, (p.vignetteMidpoint - 50) / 50)), 0, 8);
}

/** True when the params change nothing (auto scale alone has nothing to hide, so it does not count). */
export function isNeutral(params) {
  const p = normalize(params);
  return !p.distortion && !p.chromaRC && !p.chromaBY && !p.chromaGM && !p.vignette && !p.vertical && !p.horizontal && p.angle % 360 === 0 && p.scale === 100;
}

/** Renders rect r of the corrected image into a new RGBA buffer of r's size. */
function render(img, p, r, background) {
  const W = img.width, H = img.height, src = img.data;
  const out = new Uint8ClampedArray(r.width * r.height * 4);
  const scale = (p.scale / 100) * (p.autoScale ? autoScaleFactor(W, H, p) : 1);
  const m = createMapping(W, H, p, scale);
  const vig = vignetteTable(p);
  const cR = 1 + (CHROMA * p.chromaRC) / 100, cG = 1 + (CHROMA * p.chromaGM) / 100, cB = 1 + (CHROMA * p.chromaBY) / 100;
  const chroma = cR !== 1 || cG !== 1 || cB !== 1;
  const { cx, cy, R } = m;
  const gainAt = (sx, sy) => {
    const rn = Math.sqrt((sx - cx) * (sx - cx) + (sy - cy) * (sy - cy)) / R;
    if (rn >= TABLE_R) return vig[TABLE_N];
    const t = (rn / TABLE_R) * TABLE_N, i = t | 0;
    return vig[i] + (vig[i + 1] - vig[i]) * (t - i);
  };

  if (!m.geometric && !chroma) {
    // no resampling: the pixels stay exactly where they are, only the gain applies
    for (let y = 0; y < r.height; y++) {
      const sy = r.y + y;
      let o = y * r.width * 4, s = (sy * W + r.x) * 4;
      for (let x = 0; x < r.width; x++, o += 4, s += 4) {
        const g = vig ? gainAt(r.x + x + 0.5, sy + 0.5) : 1;
        out[o] = round8(src[s] * g);
        out[o + 1] = round8(src[s + 1] * g);
        out[o + 2] = round8(src[s + 2] * g);
        out[o + 3] = src[s + 3];
      }
    }
    return out;
  }

  const mode = edgeMode(p.edge);
  const bg = mode === EDGE_BACKGROUND ? parseColor(background ?? p.background, [255, 255, 255, 1]) : null;
  // one bilinear tap: premultiplied sums (tr, tg, tb), the alpha sum ta (0..255) and the part of the tap inside the image
  let tr = 0, tg = 0, tb = 0, ta = 0, cov = 0;
  const tap = (fx, fy) => {
    let x0 = Math.floor(fx), y0 = Math.floor(fy);
    const ax = fx - x0, ay = fy - y0;
    if (x0 >= 0 && y0 >= 0 && x0 < W - 1 && y0 < H - 1) {
      // the common case: all four pixels are inside the image
      const q = (y0 * W + x0) << 2, q2 = q + (W << 2);
      const a00 = src[q + 3] * (1 - ax) * (1 - ay), a10 = src[q + 7] * ax * (1 - ay), a01 = src[q2 + 3] * (1 - ax) * ay, a11 = src[q2 + 7] * ax * ay;
      tr = src[q] * a00 + src[q + 4] * a10 + src[q2] * a01 + src[q2 + 4] * a11;
      tg = src[q + 1] * a00 + src[q + 5] * a10 + src[q2 + 1] * a01 + src[q2 + 5] * a11;
      tb = src[q + 2] * a00 + src[q + 6] * a10 + src[q2 + 2] * a01 + src[q2 + 6] * a11;
      ta = a00 + a10 + a01 + a11;
      cov = 1;
      return;
    }
    let x1 = x0 + 1, y1 = y0 + 1;
    let wx0 = 1 - ax, wx1 = ax, wy0 = 1 - ay, wy1 = ay;
    if (mode === EDGE_REPEAT) {
      x0 = x0 < 0 ? 0 : x0 >= W ? W - 1 : x0;
      x1 = x1 < 0 ? 0 : x1 >= W ? W - 1 : x1;
      y0 = y0 < 0 ? 0 : y0 >= H ? H - 1 : y0;
      y1 = y1 < 0 ? 0 : y1 >= H ? H - 1 : y1;
    } else if (mode === EDGE_WRAP) {
      x0 = ((x0 % W) + W) % W;
      x1 = ((x1 % W) + W) % W;
      y0 = ((y0 % H) + H) % H;
      y1 = ((y1 % H) + H) % H;
    } else {
      if (x0 < 0 || x0 >= W) wx0 = 0;
      if (x1 < 0 || x1 >= W) wx1 = 0;
      if (y0 < 0 || y0 >= H) wy0 = 0;
      if (y1 < 0 || y1 >= H) wy1 = 0;
    }
    tr = tg = tb = ta = cov = 0;
    let w = wx0 * wy0;
    if (w > 0) {
      const q = (y0 * W + x0) << 2, a = src[q + 3] * w;
      tr += src[q] * a;
      tg += src[q + 1] * a;
      tb += src[q + 2] * a;
      ta += a;
      cov += w;
    }
    w = wx1 * wy0;
    if (w > 0) {
      const q = (y0 * W + x1) << 2, a = src[q + 3] * w;
      tr += src[q] * a;
      tg += src[q + 1] * a;
      tb += src[q + 2] * a;
      ta += a;
      cov += w;
    }
    w = wx0 * wy1;
    if (w > 0) {
      const q = (y1 * W + x0) << 2, a = src[q + 3] * w;
      tr += src[q] * a;
      tg += src[q + 1] * a;
      tb += src[q + 2] * a;
      ta += a;
      cov += w;
    }
    w = wx1 * wy1;
    if (w > 0) {
      const q = (y1 * W + x1) << 2, a = src[q + 3] * w;
      tr += src[q] * a;
      tg += src[q + 1] * a;
      tb += src[q + 2] * a;
      ta += a;
      cov += w;
    }
  };
  const pt = [0, 0];
  for (let y = 0; y < r.height; y++) {
    let o = y * r.width * 4;
    for (let x = 0; x < r.width; x++, o += 4) {
      let cr = 0, cg = 0, cb = 0, alpha = 0, inside = 0;
      if (m.map(r.x + x + 0.5, r.y + y + 0.5, pt)) {
        const sx = pt[0], sy = pt[1];
        if (!chroma) {
          tap(sx - 0.5, sy - 0.5);
          if (ta > 0) {
            cr = tr / ta;
            cg = tg / ta;
            cb = tb / ta;
          }
          alpha = ta;
          inside = cov;
        } else {
          // each channel at its own magnification; green carries the alpha and the coverage
          tap(cx + (sx - cx) * cR - 0.5, cy + (sy - cy) * cR - 0.5);
          if (ta > 0) cr = tr / ta;
          tap(cx + (sx - cx) * cB - 0.5, cy + (sy - cy) * cB - 0.5);
          if (ta > 0) cb = tb / ta;
          tap(cx + (sx - cx) * cG - 0.5, cy + (sy - cy) * cG - 0.5);
          if (ta > 0) cg = tg / ta;
          alpha = ta;
          inside = cov;
        }
        if (vig && alpha > 0) {
          const g = gainAt(sx, sy);
          cr *= g;
          cg *= g;
          cb *= g;
        }
      }
      if (bg && inside < 1) {
        // the background colour shows where the tap left the image (opaque: the layer's own transparency stays)
        const wb = (1 - inside) * 255, sum = alpha + wb;
        cr = (cr * alpha + bg[0] * wb) / sum;
        cg = (cg * alpha + bg[1] * wb) / sum;
        cb = (cb * alpha + bg[2] * wb) / sum;
        alpha = sum;
      }
      if (alpha <= 0) continue;
      out[o] = round8(cr);
      out[o + 1] = round8(cg);
      out[o + 2] = round8(cb);
      out[o + 3] = round8(alpha);
    }
  }
  return out;
}

/**
 * Lens correction of img: a new image of the same size. opts.background overrides the colour of edge
 * 'background' (params.background otherwise); opts.rect limits the pixels that are computed (the others are
 * copied), the geometry always refers to the whole image.
 * @param {ImageDataLike} img
 * @param {Partial<typeof LENS_DEFAULTS>} [params]
 * @param {{ background?: string | number[] | null, rect?: Rect | null }} [opts]
 * @returns {ImageDataLike}
 */
export function lensCorrect(img, params = {}, { background = null, rect = null } = {}) {
  const p = normalize(params);
  const out = { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) };
  const r = region(img, rect);
  if (isEmptyRegion(r) || isNeutral(p)) return out;
  const part = render(img, p, r, background);
  const row = r.width * 4;
  for (let y = 0; y < r.height; y++) out.data.set(part.subarray(y * row, (y + 1) * row), ((r.y + y) * img.width + r.x) * 4);
  return out;
}

/** The filter kind's apply: in place inside rect. */
function lensFilter(img, params, rect) {
  const p = normalize(params);
  const r = region(img, rect);
  if (isEmptyRegion(r) || isNeutral(p)) return img;
  const part = render(img, p, r, null);
  const row = r.width * 4;
  for (let y = 0; y < r.height; y++) img.data.set(part.subarray(y * row, (y + 1) * row), ((r.y + y) * img.width + r.x) * 4);
  return img;
}

// ---------------------------------------------------------------------------------------------
// Horizon detection

/** Longest side of the grey copy the Hough transform runs on. */
const HOUGH_SIZE = 320;
/** Angles searched around the horizontal (degrees) and their step. */
const HOUGH_RANGE = 45, HOUGH_STEP = 0.5;

/** Premultiplied luminance of img, box-averaged down so the longest side is at most `max`. */
function grayCopy(img, max) {
  const f = Math.max(1, Math.ceil(Math.max(img.width, img.height) / max));
  const w = Math.max(1, Math.floor(img.width / f)), h = Math.max(1, Math.floor(img.height / f));
  const g = new Float32Array(w * h), d = img.data, W = img.width;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let j = 0; j < f; j++) {
        let q = ((y * f + j) * W + x * f) * 4;
        for (let i = 0; i < f; i++, q += 4) sum += (0.299 * d[q] + 0.587 * d[q + 1] + 0.114 * d[q + 2]) * d[q + 3];
      }
      g[y * w + x] = sum / (f * f * 255);
    }
  }
  return { width: w, height: h, data: g, factor: f };
}

/**
 * The dominant near-horizontal straight edge of an image: a Hough transform over the edge pixels (Sobel,
 * each voting only for line angles close to its own gradient's) within ±45° of the horizontal, the winner
 * refined by a least-squares fit through the edge pixels on it.
 *
 * angle is in degrees, clockwise positive like the `angle` parameter: 3 means the horizon's right end sits
 * lower, and a correction of -3 levels it. confidence (0..1) is the share of the image width the line's
 * edge pixels cover. Returns null when the image has no usable edges.
 * @param {ImageDataLike} img
 * @returns {{ angle: number, confidence: number, line: { x0: number, y0: number, x1: number, y1: number } } | null}
 */
export function detectHorizon(img) {
  if (!img || img.width < 8 || img.height < 8) return null;
  const gray = grayCopy(img, HOUGH_SIZE);
  const w = gray.width, h = gray.height, g = gray.data;
  if (w < 8 || h < 8) return null;
  // Sobel gradients of the interior
  const n = w * h;
  const gx = new Float32Array(n), gy = new Float32Array(n), mag = new Float32Array(n);
  let maxMag = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const a = g[i - w - 1], b = g[i - w], c = g[i - w + 1], d = g[i - 1], f = g[i + 1], k = g[i + w - 1], l = g[i + w], o = g[i + w + 1];
      const sx = c + 2 * f + o - a - 2 * d - k, sy = k + 2 * l + o - a - 2 * b - c;
      gx[i] = sx;
      gy[i] = sy;
      const mm = Math.sqrt(sx * sx + sy * sy);
      mag[i] = mm;
      if (mm > maxMag) maxMag = mm;
    }
  }
  if (maxMag < 24) return null; // flat image
  const threshold = Math.max(16, maxMag * 0.25);
  // edge pixels whose edge direction is within 55° of the horizontal (the gradient points across the line)
  const ex = [], ey = [], ea = [];
  const cxs = w / 2, cys = h / 2;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (mag[i] < threshold) continue;
      // line angle = gradient angle - 90°, folded into (-90°, 90°]
      let a = Math.atan2(gy[i], gx[i]) / DEG - 90;
      while (a <= -90) a += 180;
      while (a > 90) a -= 180;
      if (Math.abs(a) > HOUGH_RANGE + 10) continue;
      ex.push(x + 0.5 - cxs);
      ey.push(y + 0.5 - cys);
      ea.push(a);
    }
  }
  if (ex.length < 12) return null;
  const nA = Math.round((2 * HOUGH_RANGE) / HOUGH_STEP) + 1;
  const D = Math.ceil(Math.hypot(cxs, cys)) + 1, nR = 2 * D + 1;
  const acc = new Uint32Array(nA * nR);
  const sinT = new Float64Array(nA), cosT = new Float64Array(nA);
  for (let i = 0; i < nA; i++) {
    const a = (-HOUGH_RANGE + i * HOUGH_STEP) * DEG;
    sinT[i] = Math.sin(a);
    cosT[i] = Math.cos(a);
  }
  const GATE = 12; // degrees around the pixel's own edge direction it votes for
  for (let e = 0; e < ex.length; e++) {
    const i0 = Math.max(0, Math.ceil((ea[e] - GATE + HOUGH_RANGE) / HOUGH_STEP)), i1 = Math.min(nA - 1, Math.floor((ea[e] + GATE + HOUGH_RANGE) / HOUGH_STEP));
    for (let i = i0; i <= i1; i++) {
      // distance of the line from the centre along its normal (-sin, cos)
      const rho = -ex[e] * sinT[i] + ey[e] * cosT[i];
      acc[i * nR + Math.round(rho) + D]++;
    }
  }
  // the peak, counting the neighbouring distance bins (a line seldom falls into one bin exactly)
  let best = -1, bi = 0, br = 0;
  for (let i = 0; i < nA; i++) {
    const row = i * nR;
    for (let k = 1; k < nR - 1; k++) {
      const v = acc[row + k] * 2 + acc[row + k - 1] + acc[row + k + 1];
      // ties go to the angle closest to level
      if (v > best || (v === best && Math.abs(i - (nA - 1) / 2) < Math.abs(bi - (nA - 1) / 2))) {
        best = v;
        bi = i;
        br = k;
      }
    }
  }
  if (best < 24) return null;
  // refine: fit y = m x + c through the edge pixels close to the line (two rounds, the band narrows)
  let angle = -HOUGH_RANGE + bi * HOUGH_STEP, rho = br - D, used = 0, minX = 0, maxX = 0;
  for (const band of [2.5, 1.5, 1.5]) {
    const s = Math.sin(angle * DEG), c = Math.cos(angle * DEG);
    let sw = 0, sxx = 0, sxy = 0, sx1 = 0, sy1 = 0;
    minX = Infinity;
    maxX = -Infinity;
    for (let e = 0; e < ex.length; e++) {
      if (Math.abs(-ex[e] * s + ey[e] * c - rho) > band || Math.abs(ea[e] - angle) > GATE * 1.5) continue;
      sw++;
      sx1 += ex[e];
      sy1 += ey[e];
      sxx += ex[e] * ex[e];
      sxy += ex[e] * ey[e];
      if (ex[e] < minX) minX = ex[e];
      if (ex[e] > maxX) maxX = ex[e];
    }
    const den = sw * sxx - sx1 * sx1;
    if (sw < 8 || Math.abs(den) < 1e-9) break;
    const slope = (sw * sxy - sx1 * sy1) / den, icpt = (sy1 - slope * sx1) / sw;
    angle = Math.atan(slope) / DEG;
    rho = icpt * Math.cos(angle * DEG); // the line's distance from the centre along its normal
    used = sw;
  }
  if (!used) return null;
  const f = gray.factor, t = Math.tan(angle * DEG), y0 = rho / Math.cos(angle * DEG);
  const confidence = clampNum((maxX - minX + 1) / w, 0, 1);
  return {
    angle,
    confidence,
    // the fitted line across the whole image width, in image pixels
    line: { x0: 0, y0: (cys + y0 - cxs * t) * f, x1: img.width, y1: (cys + y0 + (img.width / f - cxs) * t) * f },
  };
}

/**
 * The tilt of a line the user drew along something that should be level or upright: degrees (clockwise
 * positive) off the nearer of the two axes, in -45..45. Subtracting it from `angle` straightens the image.
 */
export function straightenAngle(x0, y0, x1, y1) {
  const dx = x1 - x0, dy = y1 - y0;
  if (!dx && !dy) return 0;
  let a = Math.atan2(dy, dx) / DEG; // the direction of drawing does not matter: fold into (-90, 90]
  while (a <= -90) a += 180;
  while (a > 90) a -= 180;
  if (a > 45) a -= 90;
  else if (a < -45) a += 90;
  return a;
}

/**
 * Positions of the dialog's grid lines: one through the centre of the image and one every `size` pixels to
 * both sides, shifted by the offsets. Returns { xs, ys } in image pixels, ascending.
 */
export function gridLines(width, height, size = 64, { offsetX = 0, offsetY = 0 } = {}) {
  const step = Math.max(2, num(Number(size), 64));
  const lines = (length, offset) => {
    const out = [];
    const c = length / 2 + (((num(Number(offset), 0) % step) + step) % step);
    for (let v = c - Math.floor(c / step) * step; v <= length; v += step) out.push(v);
    return out;
  };
  return { xs: lines(width, offsetX), ys: lines(height, offsetY) };
}

// ---------------------------------------------------------------------------------------------
// Registry

const S = (key, label, min, max, step = 1, extra = {}) => ({ key, label, type: 'slider', min, max, step, ...extra });

/** Field specs (the dialog in lib/lens-correction.js groups them; other callers read the ranges). */
export const LENS_FIELDS = Object.freeze([
  S('distortion', 'Remove distortion', -100, 100),
  S('chromaRC', 'Fix red/cyan fringe', -100, 100),
  S('chromaGM', 'Fix green/magenta fringe', -100, 100),
  S('chromaBY', 'Fix blue/yellow fringe', -100, 100),
  S('vignette', 'Vignette amount', -100, 100),
  S('vignetteMidpoint', 'Vignette midpoint', 0, 100),
  S('vertical', 'Vertical perspective', -100, 100),
  S('horizontal', 'Horizontal perspective', -100, 100),
  S('angle', 'Angle', -180, 180, 0.1, { unit: '°' }),
  S('scale', 'Scale', 50, 150, 1, { unit: '%' }),
  { key: 'edge', label: 'Edge', type: 'select', options: [['transparent', 'Transparency'], ['repeat', 'Edge extension'], ['wrap', 'Wrap around'], ['background', 'Background color']] },
  { key: 'autoScale', label: 'Auto scale image', type: 'checkbox' },
]);

export const LENS_FILTERS = Object.freeze({
  'lens-correction': defineFilter('Lens Correction', 'special', { ...LENS_DEFAULTS }, lensFilter, { ui: 'custom', fields: LENS_FIELDS }),
});
