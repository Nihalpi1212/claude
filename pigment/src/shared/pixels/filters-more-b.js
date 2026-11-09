// Filter menu kinds added in 0.3, part B (builder "filters-b"): Displace, the Render generators
// (Fibers, Lighting Effects, Tree, Flame, Picture Frame) and the rest of Stylize (Extrude, Tiles,
// Trace Contour, Wind). The conventions at the top of filters.js hold: rect limits writes only
// (geometry, grids and noise refer to the whole image), straight alpha in and out, deterministic
// noise per seed and position, typed arrays and plain loops, nothing read outside the image.
//
// The generators (Tree, Flame, Picture Frame) paint into a premultiplied float buffer and composite
// it over the existing pixels with source-over, so they render onto an empty layer the way
// Photoshop does (alpha stays 0 where nothing is drawn). Fibers and Lighting Effects replace the
// pixels like their Photoshop counterparts.
//
// Parameters that are not JSON (Displace's `map`) are kept as typed arrays: the renderer stores
// the map on the params object with a `toJSON` that drops it, so settings, Last Filter and the
// actions recorder never serialise megabytes of pixels (lib/filters-b-ui.js).

import { clampRect, randomSeeded, luminance } from './core.js';
import { parseColor } from './color.js';
import { num, clampNum, round8, smoothstep, DEG, TAU, defineFilter } from './filter-def.js';

/** @typedef {import('./core.js').ImageDataLike} ImageDataLike */

// ---------------------------------------------------------------------------------------------
// Small helpers (module private)

const region = (img, rect) => clampRect(rect, img.width, img.height);
const isEmpty = (r) => r.width <= 0 || r.height <= 0;
const clampI = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** Integer hash of three int32s (position-stable noise, cell jitter, lattice values). */
function hash3(x, y, z) {
  let h = (Math.imul(x | 0, 0x27d4eb2d) + Math.imul(y | 0, 0x165667b1) + Math.imul(z | 0, 0x9e3779b1)) | 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}
const U32 = 4294967296;
/** Uniform 0..1 at an integer lattice point. */
const lat = (x, y, z) => hash3(x, y, z) / U32;

/** Smooth value noise (0..1) at a fractional lattice position; z selects an independent field. */
function vnoise(x, y, z) {
  const xi = Math.floor(x), yi = Math.floor(y);
  let tx = x - xi, ty = y - yi;
  tx = tx * tx * (3 - 2 * tx);
  ty = ty * ty * (3 - 2 * ty);
  const a = lat(xi, yi, z), b = lat(xi + 1, yi, z), c = lat(xi, yi + 1, z), d = lat(xi + 1, yi + 1, z);
  return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
}

/** Fractal sum of value-noise octaves, normalised to 0..1 (mean 0.5). */
function fbm(x, y, z, octaves) {
  let s = 0, amp = 0.5, f = 1, norm = 0;
  for (let o = 0; o < octaves; o++) {
    s += vnoise(x * f, y * f, z + o * 131) * amp;
    norm += amp;
    amp *= 0.5;
    f *= 2;
  }
  return s / norm;
}

/** '#rrggbb' (or any parseColor input) -> [r, g, b] 0..255. */
function rgbOf(c, fallback = '#000000') {
  const p = parseColor(c, parseColor(fallback));
  return [p[0], p[1], p[2]];
}

/** [fg, bg] RGB of `colors: [fg, bg]` params (fg / bg keys also accepted, as for Clouds). */
function colorsOf(p, fgDefault, bgDefault) {
  const cols = Array.isArray(p.colors) ? p.colors : [];
  return [rgbOf(p.fg ?? cols[0] ?? fgDefault, fgDefault), rgbOf(p.bg ?? cols[1] ?? bgDefault, bgDefault)];
}

function normalize3(x, y, z) {
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
}

/** Seed of one row's randomSeeded stream: stable per (seed, salt, y) whatever the rect is. */
const rowSeed = (seed, salt, y) => (Math.imul((seed | 0) + salt, 0x9e3779b1) ^ Math.imul(y + 1, 0x85ebca6b)) >>> 0;

// ---- premultiplied float paint buffer (generators) -------------------------------------------

/** Source-over of a straight colour (0..1) with coverage a into a premultiplied buffer at float index o. */
function over(acc, o, r, g, b, a) {
  if (a <= 0) return;
  if (a > 1) a = 1;
  const k = 1 - a;
  acc[o] = r * a + acc[o] * k;
  acc[o + 1] = g * a + acc[o + 1] * k;
  acc[o + 2] = b * a + acc[o + 2] * k;
  acc[o + 3] = a + acc[o + 3] * k;
}

/** Composites a premultiplied float buffer covering region r over img inside r (straight alpha out). */
function overRegion(img, r, acc) {
  const d = img.data, W = img.width;
  for (let y = 0; y < r.height; y++) {
    let i = ((r.y + y) * W + r.x) * 4, o = y * r.width * 4;
    for (let x = 0; x < r.width; x++, i += 4, o += 4) {
      const sa = acc[o + 3];
      if (sa <= 0.0005) continue;
      const da = d[i + 3] / 255, k = 1 - sa;
      const oa = sa + da * k;
      const pr = acc[o] + (d[i] / 255) * da * k;
      const pg = acc[o + 1] + (d[i + 1] / 255) * da * k;
      const pb = acc[o + 2] + (d[i + 2] / 255) * da * k;
      d[i] = round8((pr / oa) * 255);
      d[i + 1] = round8((pg / oa) * 255);
      d[i + 2] = round8((pb / oa) * 255);
      d[i + 3] = round8(oa * 255);
    }
  }
  return img;
}

/**
 * A scene the generators draw into: a premultiplied buffer over region r, the light vector and the
 * camera tilt (vertical squash about baseY, Tree only).
 */
function makeScene(r, light = [0, 0, 1], tilt = 1, baseY = 0) {
  return { acc: new Float32Array(r.width * r.height * 4), r, light, tilt, baseY };
}
const sceneY = (s, y) => s.baseY - (s.baseY - y) * s.tilt;

/** Anti-aliased filled ellipse (rx along `ang`), colour 0..255, drawn into the scene. */
function drawEllipse(s, cx, cy, rx, ry, ang, rgb, alpha = 1) {
  const { acc, r } = s;
  cy = sceneY(s, cy);
  const rad = Math.max(rx, ry) + 1;
  const xa = clampI(Math.floor(cx - rad), r.x, r.x + r.width), xb = clampI(Math.ceil(cx + rad) + 1, r.x, r.x + r.width);
  const ya = clampI(Math.floor(cy - rad), r.y, r.y + r.height), yb = clampI(Math.ceil(cy + rad) + 1, r.y, r.y + r.height);
  if (xa >= xb || ya >= yb) return;
  const c = Math.cos(ang), sn = Math.sin(ang), minR = Math.max(0.5, Math.min(rx, ry));
  const cr = rgb[0] / 255, cg = rgb[1] / 255, cb = rgb[2] / 255;
  for (let y = ya; y < yb; y++) {
    const dy = y + 0.5 - cy;
    for (let x = xa; x < xb; x++) {
      const dx = x + 0.5 - cx;
      const lx = dx * c + dy * sn, ly = -dx * sn + dy * c;
      const e = Math.sqrt((lx * lx) / (rx * rx) + (ly * ly) / (ry * ry));
      const cover = clampNum((1 - e) * minR + 0.5, 0, 1) * alpha;
      if (cover <= 0) continue;
      over(acc, ((y - r.y) * r.width + (x - r.x)) * 4, cr, cg, cb, cover);
    }
  }
}

/**
 * Tapered cylinder segment lit by the scene light: the surface normal across the width is
 * (u * perp, sqrt(1 - u^2)), so the side facing the light is bright and the other side dark.
 * shadeFn(t, shade) may modulate the shade along the branch (bark marks).
 */
function drawBranch(s, x0, y0, x1, y1, w0, w1, rgb, shadeFn = null) {
  const { acc, r, light } = s;
  y0 = sceneY(s, y0);
  y1 = sceneY(s, y1);
  const h0 = Math.max(0.35, w0 / 2), h1 = Math.max(0.35, w1 / 2);
  const dx = x1 - x0, dy = y1 - y0, len = Math.hypot(dx, dy) || 1e-6, ux = dx / len, uy = dy / len, px = -uy, py = ux;
  const hmax = Math.max(h0, h1) + 1;
  const xa = clampI(Math.floor(Math.min(x0, x1) - hmax), r.x, r.x + r.width), xb = clampI(Math.ceil(Math.max(x0, x1) + hmax) + 1, r.x, r.x + r.width);
  const ya = clampI(Math.floor(Math.min(y0, y1) - hmax), r.y, r.y + r.height), yb = clampI(Math.ceil(Math.max(y0, y1) + hmax) + 1, r.y, r.y + r.height);
  if (xa >= xb || ya >= yb) return;
  const cr = rgb[0] / 255, cg = rgb[1] / 255, cb = rgb[2] / 255;
  for (let y = ya; y < yb; y++) {
    const ry = y + 0.5 - y0;
    for (let x = xa; x < xb; x++) {
      const rx = x + 0.5 - x0;
      const t = rx * ux + ry * uy, tc = t < 0 ? 0 : t > len ? len : t;
      const hw = h0 + (h1 - h0) * (tc / len);
      const qx = rx - ux * tc, qy = ry - uy * tc;
      const dist = Math.hypot(qx, qy);
      const cover = clampNum(hw + 0.5 - dist, 0, 1);
      if (cover <= 0) continue;
      const u = clampNum((rx * px + ry * py) / hw, -1, 1);
      const nz = Math.sqrt(Math.max(0, 1 - u * u));
      const ndl = u * px * light[0] + u * py * light[1] + nz * light[2];
      let shade = 0.28 + 0.72 * (ndl > 0 ? ndl : 0);
      if (shadeFn) shade = shadeFn(tc / len, shade, x, y);
      over(acc, ((y - r.y) * r.width + (x - r.x)) * 4, cr * shade, cg * shade, cb * shade, cover);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Displace

/** Index wrapped / clamped / rejected (-1) per edge mode (0 repeat, 1 wrap, 2 transparent). */
function wrapIndex(v, n, edge) {
  if (v >= 0 && v < n) return v;
  if (edge === 1) return ((v % n) + n) % n;
  if (edge === 2) return -1;
  return v < 0 ? 0 : n - 1;
}

/** Bilinear, alpha-weighted sample of src (W x H RGBA bytes) with the edge mode applied per tap. */
function sampleEdge(src, W, H, fx, fy, edge, out) {
  const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
  let r = 0, g = 0, b = 0, a = 0;
  for (let j = 0; j < 2; j++) {
    const wy = j ? ty : 1 - ty;
    if (wy <= 0) continue;
    const yy = wrapIndex(y0 + j, H, edge);
    if (yy < 0) continue;
    for (let i = 0; i < 2; i++) {
      const w = wy * (i ? tx : 1 - tx);
      if (w <= 0) continue;
      const xx = wrapIndex(x0 + i, W, edge);
      if (xx < 0) continue;
      const p = (yy * W + xx) * 4, pa = (src[p + 3] / 255) * w;
      r += src[p] * pa;
      g += src[p + 1] * pa;
      b += src[p + 2] * pa;
      a += pa;
    }
  }
  if (a > 0) {
    out[0] = r / a;
    out[1] = g / a;
    out[2] = b / a;
    out[3] = a * 255;
  } else out[0] = out[1] = out[2] = out[3] = 0;
  return out;
}

/** Map value -> displacement factor: 128 none, 255 exactly +1, 0 exactly -1 (piecewise so the ends are exact). */
const dispFactor = (v) => (v >= 128 ? (v - 128) / 127 : (v - 128) / 128);

function displace(img, p, rect) {
  const r = region(img, rect);
  if (isEmpty(r)) return img;
  const map = p.map;
  if (!map || !map.data || !(map.width > 0) || !(map.height > 0)) return img; // no map: nothing to do (the dialog supplies it)
  const hs = num(p.horizontalScale, 0), vs = num(p.verticalScale, 0);
  if (hs === 0 && vs === 0) return img;
  const W = img.width, H = img.height, d = img.data, src = new Uint8ClampedArray(d);
  const mw = map.width, mh = map.height, md = map.data, single = md.length === mw * mh; // a one-channel map drives both axes
  const tile = p.mapMode === 'tile';
  const edge = p.edge === 'wrap' ? 1 : p.edge === 'transparent' ? 2 : 0;
  const out = [0, 0, 0, 0];
  for (let y = r.y; y < r.y + r.height; y++) {
    const my = tile ? y % mh : Math.min(mh - 1, Math.floor(((y + 0.5) * mh) / H));
    for (let x = r.x, i = (y * W + r.x) * 4; x < r.x + r.width; x++, i += 4) {
      const mx = tile ? x % mw : Math.min(mw - 1, Math.floor(((x + 0.5) * mw) / W));
      const mi = single ? my * mw + mx : (my * mw + mx) * 4;
      const rv = md[mi], gv = single ? rv : md[mi + 1];
      // Photoshop: white displaces the image up and left (the output samples the source to the right / below)
      sampleEdge(src, W, H, x + dispFactor(rv) * hs, y + dispFactor(gv) * vs, edge, out);
      d[i] = round8(out[0]);
      d[i + 1] = round8(out[1]);
      d[i + 2] = round8(out[2]);
      d[i + 3] = round8(out[3]);
    }
  }
  return img;
}

// ---------------------------------------------------------------------------------------------
// Fibers

function fibers(img, p, rect) {
  const r = region(img, rect);
  if (isEmpty(r)) return img;
  const variance = clampNum(num(p.variance, 16), 1, 64), strength = clampNum(num(p.strength, 4), 1, 64), seed = num(p.seed, 1) | 0;
  const [fg, bg] = colorsOf(p, '#000000', '#ffffff');
  // fibres are thin across (1.6 px lattice) and long along y: the streak length shrinks as the variance grows
  const L = 600 / (variance + 4), sx = 1 / 1.6;
  const contrast = 1 + strength * 0.25; // strength sharpens the streaks (steeper contrast about the middle grey)
  const fine = (strength / 64) * 0.6, fineL = Math.max(2, L * 0.35);
  const d = img.data, W = img.width;
  for (let y = r.y; y < r.y + r.height; y++) {
    for (let x = r.x, i = (y * W + r.x) * 4; x < r.x + r.width; x++, i += 4) {
      let v = fbm(x * sx, y / L, seed, 3);
      v += (vnoise(x * 0.8, y / fineL, seed + 977) - 0.5) * fine; // stringy detail
      const t = clampNum(0.5 + (v - 0.5) * contrast, 0, 1);
      d[i] = round8(bg[0] + (fg[0] - bg[0]) * t);
      d[i + 1] = round8(bg[1] + (fg[1] - bg[1]) * t);
      d[i + 2] = round8(bg[2] + (fg[2] - bg[2]) * t);
      d[i + 3] = 255;
    }
  }
  return img;
}

// ---------------------------------------------------------------------------------------------
// Lighting Effects

const LIGHT_TYPES = ['spot', 'point', 'infinite'];

function normLight(l) {
  const o = l && typeof l === 'object' ? l : {};
  return {
    type: LIGHT_TYPES.includes(o.type) ? o.type : 'spot',
    x: clampNum(num(o.x, 0.5), -1, 2),
    y: clampNum(num(o.y, 0.5), -1, 2),
    intensity: clampNum(num(o.intensity, 35), -100, 100),
    hotspot: clampNum(num(o.hotspot, 69), 0, 100),
    color: rgbOf(o.color, '#ffffff'),
    angle: num(o.angle, 0),
    radius: clampNum(num(o.radius, 0.6), 0.01, 2),
    focus: clampNum(num(o.focus, 0.3), 0, 1),
    exposure: clampNum(num(o.exposure, 0), -100, 100),
  };
}

function lightingEffects(img, p, rect) {
  const r = region(img, rect);
  if (isEmpty(r)) return img;
  const W = img.width, H = img.height, d = img.data, diag = Math.hypot(W, H);
  const lights = (Array.isArray(p.lights) ? p.lights : []).slice(0, 16).map(normLight);
  // bump map from the texture channel; height scales the slope, whiteIsHigh flips it
  const height = clampNum(num(p.height, 50), 0, 100);
  let bump = null;
  if (p.texture && p.texture !== 'none' && height > 0) {
    bump = new Float32Array(W * H);
    const ch = p.texture === 'red' ? 0 : p.texture === 'green' ? 1 : p.texture === 'blue' ? 2 : p.texture === 'alpha' ? 3 : -1;
    const flip = p.whiteIsHigh === false;
    for (let i = 0, o = 0; i < d.length; i += 4, o++) {
      const v = ch < 0 ? luminance(d[i], d[i + 1], d[i + 2]) : d[i + ch];
      bump[o] = flip ? 255 - v : v;
    }
  }
  const bumpScale = (height / 100) * 0.04;
  const amb = clampNum(num(p.ambient, 0), -100, 100) / 100;
  const ambC = rgbOf(p.ambientColor, '#ffffff');
  const ar = Math.max(0, amb) * (ambC[0] / 255), ag = Math.max(0, amb) * (ambC[1] / 255), ab = Math.max(0, amb) * (ambC[2] / 255);
  // negative ambience dims the whole lit result, exposure is a gain in stops (50 = one stop)
  const gain = Math.pow(2, clampNum(num(p.exposure, 0), -100, 100) / 50) * (amb < 0 ? 1 + amb * 0.6 : 1);
  const gloss = clampNum(num(p.gloss, 0), -100, 100), metallic = clampNum(num(p.metallic, 69), -100, 100);
  const shin = 4 + ((gloss + 100) / 200) * 60, ks = 0.15 + ((gloss + 100) / 200) * 0.5;
  const metal = (metallic + 100) / 200; // 0 plastic (white highlights) .. 1 metallic (surface-coloured highlights)
  // per-light constants
  const L = lights.map((l) => {
    const px = l.x * W, py = l.y * H, R = Math.max(1, (l.radius * diag) / 2);
    const I = (l.intensity / 35) * Math.pow(2, l.exposure / 50);
    const c = [l.color[0] / 255, l.color[1] / 255, l.color[2] / 255];
    const a = l.angle * DEG, ca = Math.cos(a), sa = Math.sin(a);
    let dir = null;
    if (l.type === 'infinite') {
      const elev = (20 + l.radius * 70) * DEG; // the radius slider doubles as the sun's elevation for a directional light
      dir = normalize3(Math.cos(a) * Math.cos(elev), -Math.sin(a) * Math.cos(elev), Math.sin(elev));
    }
    return { ...l, px, py, R, I, c, ca, sa, dir, hot: (l.hotspot / 100) * 0.95, minor: R * (1 - 0.5 * l.focus), lz: l.type === 'spot' ? R : R * 0.75 };
  });
  for (let y = r.y; y < r.y + r.height; y++) {
    for (let x = r.x, i = (y * W + r.x) * 4; x < r.x + r.width; x++, i += 4) {
      const a = d[i + 3];
      if (a === 0) continue; // nothing to light
      let nx = 0, ny = 0, nz = 1;
      if (bump) {
        const o = y * W + x;
        const gx = (bump[x < W - 1 ? o + 1 : o] - bump[x > 0 ? o - 1 : o]) * bumpScale;
        const gy = (bump[y < H - 1 ? o + W : o] - bump[y > 0 ? o - W : o]) * bumpScale;
        const inv = 1 / Math.hypot(gx, gy, 1);
        nx = -gx * inv;
        ny = -gy * inv;
        nz = inv;
      }
      let lr = ar, lg = ag, lb = ab, sr = 0, sg = 0, sb = 0;
      for (let k = 0; k < L.length; k++) {
        const l = L[k];
        let lx, ly, lz, f;
        if (l.dir) {
          lx = l.dir[0];
          ly = l.dir[1];
          lz = l.dir[2];
          f = 1;
        } else {
          const dx = l.px - (x + 0.5), dy = l.py - (y + 0.5);
          const inv = 1 / Math.hypot(dx, dy, l.lz);
          lx = dx * inv;
          ly = dy * inv;
          lz = l.lz * inv;
          if (l.type === 'spot') {
            // elliptical cone footprint rotated by angle: full inside the hotspot, smooth falloff to the rim
            const u = -dx * l.ca - dy * l.sa, v = dx * l.sa - dy * l.ca;
            const e = Math.sqrt((u * u) / (l.R * l.R) + (v * v) / (l.minor * l.minor));
            f = e <= l.hot ? 1 : e >= 1 ? 0 : smoothstep(1, l.hot, e);
          } else {
            const dd = (dx * dx + dy * dy) / (l.R * l.R);
            f = 1 / (1 + dd * 3);
          }
        }
        if (f <= 0) continue;
        const ndl = nx * lx + ny * ly + nz * lz;
        const diff = l.I * f * (ndl > 0 ? ndl : 0);
        lr += diff * l.c[0];
        lg += diff * l.c[1];
        lb += diff * l.c[2];
        // Blinn-Phong highlight, view vector straight down (0, 0, 1)
        const hl = Math.hypot(lx, ly, lz + 1) || 1;
        const ndh = (nx * lx + ny * ly + nz * (lz + 1)) / hl;
        if (ndh > 0 && l.I > 0) {
          const spec = l.I * f * ks * Math.pow(ndh, shin);
          sr += spec * l.c[0];
          sg += spec * l.c[1];
          sb += spec * l.c[2];
        }
      }
      const br = d[i] / 255, bg = d[i + 1] / 255, bb = d[i + 2] / 255;
      d[i] = round8((br * lr + sr * (metal * br + (1 - metal))) * gain * 255);
      d[i + 1] = round8((bg * lg + sg * (metal * bg + (1 - metal))) * gain * 255);
      d[i + 2] = round8((bb * lb + sb * (metal * bb + (1 - metal))) * gain * 255);
    }
  }
  return img;
}

// ---------------------------------------------------------------------------------------------
// Tree

/**
 * Species presets. form: 'branching' (recursive fan of children), 'conifer' (straight trunk with
 * tiers of side branches), 'willow' (branching plus hanging strands), 'palm' (curved trunk, fronds).
 * `natural` is the leaf colour used when the dialog's leaf colour is left at its default.
 */
const TREE_SPECIES = Object.freeze({
  oak: { form: 'branching', levels: 5, spread: 70, ratio: 0.68, kids: [2, 3], taper: 0.62, curve: 0.5, thick: 1.0, leaf: 'round', leafScale: 1.0, natural: '#4caf50' },
  maple: { form: 'branching', levels: 5, spread: 60, ratio: 0.7, kids: [2, 3], taper: 0.6, curve: 0.35, thick: 0.9, leaf: 'round', leafScale: 1.15, natural: '#e65100' },
  birch: { form: 'branching', levels: 5, spread: 40, ratio: 0.74, kids: [2, 2], taper: 0.6, curve: 0.3, thick: 0.55, leaf: 'round', leafScale: 0.7, natural: '#8bc34a', bark: 'birch' },
  elm: { form: 'branching', levels: 6, spread: 45, ratio: 0.72, kids: [2, 3], taper: 0.62, curve: 0.3, thick: 0.85, leaf: 'round', leafScale: 0.8, natural: '#43a047' },
  'cherry-blossom': { form: 'branching', levels: 5, spread: 75, ratio: 0.66, kids: [2, 3], taper: 0.6, curve: 0.6, thick: 0.8, leaf: 'blossom', leafScale: 0.9, natural: '#f8bbd0' },
  apple: { form: 'branching', levels: 4, spread: 80, ratio: 0.7, kids: [3, 3], taper: 0.6, curve: 0.5, thick: 0.9, leaf: 'round', leafScale: 1.0, natural: '#558b2f', fruit: '#e53935' },
  bare: { form: 'branching', levels: 6, spread: 65, ratio: 0.7, kids: [2, 3], taper: 0.62, curve: 0.5, thick: 1.0, leaf: 'none', leafScale: 1, natural: '#4caf50' },
  pine: { form: 'conifer', tiers: 9, start: 0.42, droop: 0.35, tierLen: 0.42, thick: 0.8, leaf: 'needle', leafScale: 1.0, natural: '#2e7d32' },
  spruce: { form: 'conifer', tiers: 14, start: 0.12, droop: 0.12, tierLen: 0.5, thick: 0.7, leaf: 'needle', leafScale: 0.8, natural: '#1b5e20' },
  willow: { form: 'willow', levels: 4, spread: 70, ratio: 0.7, kids: [2, 3], taper: 0.6, curve: 0.5, thick: 1.1, leaf: 'drooping', leafScale: 0.7, natural: '#7cb342' },
  palm: { form: 'palm', fronds: 9, thick: 0.6, leaf: 'frond', leafScale: 1, natural: '#388e3c' },
});
export const TREE_TYPES = Object.freeze(Object.keys(TREE_SPECIES));
const DEFAULT_LEAF = '#4caf50', DEFAULT_BRANCH = '#6d4c41';

function tree(img, p, rect) {
  const r = region(img, rect);
  if (isEmpty(r)) return img;
  const W = img.width, H = img.height;
  const sp = TREE_SPECIES[p.type] ?? TREE_SPECIES.oak;
  const seed = num(p.seed, 1) | 0, arr = num(p.arrangement, 1) | 0;
  const rnd = randomSeeded(hash3(seed, arr, 0x7ee) || 1);
  const hRel = clampNum(num(p.branchesHeight, 160), 70, 300) / 160;
  const treeH = clampNum(H * 0.86 * hRel, H * 0.2, H * 0.96);
  const baseX = W / 2, baseY = H - Math.max(2, H * 0.03);
  const tilt = Math.cos(clampNum(num(p.cameraTilt, 0), 0, 80) * DEG);
  const thickRel = clampNum(num(p.branchesThickness, 100), 0, 200) / 100;
  const trunkW = Math.max(1, treeH * 0.055 * thickRel * sp.thick);
  const amount = clampNum(num(p.leavesAmount, 70), 0, 100) / 100;
  const leafSize = Math.max(1, treeH * 0.03 * (clampNum(num(p.leavesSize, 100), 0, 200) / 100) * sp.leafScale);
  const defaultBranch = String(p.branchColor ?? DEFAULT_BRANCH).toLowerCase() === DEFAULT_BRANCH;
  const branchRGB = defaultBranch && sp.bark === 'birch' ? rgbOf('#e8e4dc') : rgbOf(p.branchColor, DEFAULT_BRANCH);
  // the default leaf colour means "the species' natural colour" (maple orange, cherry pink, ...)
  const leafRGB = String(p.leafColor ?? DEFAULT_LEAF).toLowerCase() === DEFAULT_LEAF ? rgbOf(sp.natural) : rgbOf(p.leafColor, DEFAULT_LEAF);
  const ld = clampNum(num(p.lightDirection, 90), 0, 180) * DEG;
  const light = normalize3(-Math.cos(ld), -0.25, Math.sin(ld) + 0.3);
  const s = makeScene(r, light, tilt, baseY);
  // leaves on the lit side of the crown are brighter
  const lit = (x) => 1 + 0.3 * clampNum((baseX - x) / (treeH * 0.5), -1, 1) * Math.cos(ld);
  const leafKind = p.defaultLeaves === false && sp.leaf !== 'none' ? 'disc' : sp.leaf;
  const t = { sp, rnd, baseX, baseY, treeH, trunkW, amount, leafSize, branchRGB, leafRGB, leafKind, lit, s, branches: [], leaves: [], fruit: [] };
  if (sp.form === 'conifer') growConifer(t);
  else if (sp.form === 'palm') growPalm(t);
  else growBranching(t, sp.form === 'willow');
  // trunk first, twigs last, then foliage over everything
  t.branches.sort((a, b) => a.level - b.level);
  const birch = sp.bark === 'birch' && defaultBranch;
  for (const b of t.branches) {
    const shadeFn = birch && b.level <= 1 ? (_f, shade, x, y) => (vnoise(x * 0.08, y * 0.45, seed + 55) > 0.72 ? shade * 0.25 : shade) : null;
    drawBranch(s, b.x0, b.y0, b.x1, b.y1, b.w0, b.w1, b.rgb ?? branchRGB, shadeFn);
  }
  for (const l of t.leaves) drawLeaf(t, l);
  for (const f of t.fruit) drawEllipse(s, f.x, f.y, f.r, f.r, 0, f.rgb);
  return overRegion(img, r, s.acc);
}

/** Shaded leaf colour: species colour times a per-leaf variation and the lit-side factor. */
function leafColor(t, x, v) {
  const k = clampNum(v * t.lit(x), 0.35, 1.6);
  return [clampNum(t.leafRGB[0] * k, 0, 255), clampNum(t.leafRGB[1] * k, 0, 255), clampNum(t.leafRGB[2] * k, 0, 255)];
}

function addLeaf(t, x, y, ang, scale = 1) {
  t.leaves.push({ x, y, ang, scale, v: 0.8 + t.rnd() * 0.4 });
}

/** Leaves scattered along a branch (count follows the amount), with sideways jitter. */
function leavesAlong(t, x0, y0, x1, y1, density = 2.2) {
  if (t.leafKind === 'none' || t.amount <= 0) return;
  const len = Math.hypot(x1 - x0, y1 - y0);
  const n = Math.round((len / t.leafSize) * density * t.amount);
  const px = -(y1 - y0) / (len || 1), py = (x1 - x0) / (len || 1);
  for (let k = 0; k < n; k++) {
    const f = 0.15 + t.rnd() * 0.85, side = (t.rnd() - 0.5) * 1.4 * t.leafSize;
    addLeaf(t, x0 + (x1 - x0) * f + px * side, y0 + (y1 - y0) * f + py * side, t.rnd() * TAU);
  }
}

function drawLeaf(t, l) {
  const { s, leafSize } = t;
  const size = leafSize * l.scale, rgb = leafColor(t, l.x, l.v);
  switch (t.leafKind) {
    case 'round':
      drawEllipse(s, l.x, l.y, size * 0.5, size * 0.32, l.ang, rgb);
      break;
    case 'needle':
      drawEllipse(s, l.x, l.y, size * 0.6, Math.max(0.4, size * 0.08), l.ang, rgb);
      break;
    case 'blossom': {
      // a five-petal cluster with a lighter centre
      for (let k = 0; k < 5; k++) {
        const a = l.ang + (k / 5) * TAU;
        drawEllipse(s, l.x + Math.cos(a) * size * 0.22, l.y + Math.sin(a) * size * 0.22, size * 0.2, size * 0.16, a, rgb);
      }
      drawEllipse(s, l.x, l.y, size * 0.12, size * 0.12, 0, [255, 245, 240]);
      break;
    }
    case 'frond':
      drawEllipse(s, l.x, l.y, size * 0.7, Math.max(0.4, size * 0.1), l.ang, rgb);
      break;
    default:
      drawEllipse(s, l.x, l.y, size * 0.4, size * 0.4, 0, rgb);
  }
}

/** Recursive fan of children; each generation is `ratio` as long as its parent. Willows add hanging strands at the tips. */
function growBranching(t, willow) {
  const { sp, rnd, baseX, baseY, treeH, trunkW } = t;
  // the trunk and `levels` generations shrinking by `ratio` add up to treeH along the straightest path
  const sum = (1 - Math.pow(sp.ratio, sp.levels + 1)) / (1 - sp.ratio);
  const trunkLen = treeH / sum;
  const rec = (x, y, ang, len, w, level) => {
    const ex = x + Math.sin(ang) * len, ey = y - Math.cos(ang) * len;
    const w1 = level === sp.levels ? Math.max(0.6, w * 0.3) : Math.max(0.6, w * sp.taper);
    t.branches.push({ x0: x, y0: y, x1: ex, y1: ey, w0: w, w1, level });
    if (level >= sp.levels - 1) leavesAlong(t, x, y, ex, ey);
    if (level >= sp.levels) {
      if (willow) strands(t, ex, ey, ang, level + 1);
      else if (t.leafKind !== 'none' && t.amount > 0) {
        for (let k = 0, n = 1 + Math.round(2 * t.amount); k < n; k++) addLeaf(t, ex + (rnd() - 0.5) * t.leafSize, ey + (rnd() - 0.5) * t.leafSize, rnd() * TAU);
        if (sp.fruit && rnd() < 0.3 * t.amount) t.fruit.push({ x: ex + (rnd() - 0.5) * t.leafSize, y: ey + t.leafSize * 0.4, r: Math.max(1, t.leafSize * 0.28), rgb: rgbOf(sp.fruit) });
      }
      return;
    }
    const n = sp.kids[0] + Math.floor(rnd() * (sp.kids[1] - sp.kids[0] + 1));
    for (let k = 0; k < n; k++) {
      const fan = n === 1 ? 0 : (k / (n - 1) - 0.5) * 2;
      let a = ang + fan * sp.spread * DEG * 0.5 + (rnd() - 0.5) * sp.curve;
      a *= 0.92; // branches lean back toward the vertical
      const start = level === 0 ? 1 : 0.75 + rnd() * 0.25; // side branches may leave before the parent's tip
      rec(x + (ex - x) * start, y + (ey - y) * start, a, len * sp.ratio * (0.8 + rnd() * 0.4), w1 * (0.85 + rnd() * 0.15), level + 1);
    }
  };
  rec(baseX, baseY, (rnd() - 0.5) * 0.1, trunkLen, trunkW, 0);
}

/** Willow strands: thin chains hanging from a tip, bending toward straight down, with small leaves. */
function strands(t, x, y, ang, level) {
  const { rnd, treeH } = t;
  const n = 2 + Math.floor(rnd() * 3);
  for (let k = 0; k < n; k++) {
    let a = ang + (rnd() - 0.5) * 1.2, px = x, py = y;
    const segs = 6 + Math.floor(rnd() * 5), segLen = (treeH * (0.25 + rnd() * 0.15)) / segs;
    for (let i = 0; i < segs; i++) {
      // bend toward pi (down); the sway keeps strands from being straight lines
      a += (Math.PI * Math.sign(a || 1) - a) * 0.35 + (rnd() - 0.5) * 0.15;
      const nx = px + Math.sin(a) * segLen, ny = py - Math.cos(a) * segLen;
      t.branches.push({ x0: px, y0: py, x1: nx, y1: ny, w0: 1.3 - i * 0.08, w1: 1.2 - i * 0.08, level, rgb: t.branchRGB });
      leavesAlong(t, px, py, nx, ny, 1.2);
      px = nx;
      py = ny;
    }
  }
}

/** Straight trunk with tiers of side branches shrinking toward the top (a cone); needles along each branch. */
function growConifer(t) {
  const { sp, rnd, baseX, baseY, treeH, trunkW } = t;
  const topY = baseY - treeH;
  t.branches.push({ x0: baseX, y0: baseY, x1: baseX + (rnd() - 0.5) * treeH * 0.02, y1: topY, w0: trunkW, w1: Math.max(0.8, trunkW * 0.12), level: 0 });
  for (let i = 0; i < sp.tiers; i++) {
    const f = sp.start + (1 - sp.start) * (i / sp.tiers);
    const y = baseY - treeH * f;
    const tierLen = treeH * sp.tierLen * (1 - f) + treeH * 0.02;
    const w = Math.max(0.6, trunkW * 0.22 * (1 - f) + 0.6);
    const count = 4 + Math.floor(rnd() * 3);
    for (let k = 0; k < count; k++) {
      const phi = (k / count) * TAU + rnd() * 0.6;
      const side = Math.cos(phi); // branches all round the trunk, projected to the screen
      const len = tierLen * (0.45 + 0.55 * Math.abs(side));
      const dir = side >= 0 ? 1 : -1;
      const ang = dir * (Math.PI / 2 + sp.droop * (0.5 + rnd() * 0.5));
      const ex = baseX + Math.sin(ang) * len, ey = y - Math.cos(ang) * len;
      t.branches.push({ x0: baseX, y0: y, x1: ex, y1: ey, w0: w, w1: Math.max(0.5, w * 0.4), level: 1 });
      needles(t, baseX, y, ex, ey, ang);
    }
  }
  // the leader carries a tuft of needles
  for (let k = 0, n = Math.round(8 * t.amount); k < n; k++) addLeaf(t, baseX + (rnd() - 0.5) * t.leafSize, topY + rnd() * treeH * 0.06, (rnd() - 0.5) * 1.2, 0.8);
}

/** Needles on both sides of a branch, angled toward its tip. */
function needles(t, x0, y0, x1, y1, ang) {
  if (t.leafKind === 'none' || t.amount <= 0) return;
  const { rnd, leafSize } = t;
  const len = Math.hypot(x1 - x0, y1 - y0);
  const n = Math.round((len / leafSize) * 2.2 * t.amount);
  for (let k = 0; k < n; k++) {
    const f = 0.1 + rnd() * 0.9, side = rnd() < 0.5 ? 1 : -1;
    const a = ang + side * (55 + rnd() * 30) * DEG;
    const bx = x0 + (x1 - x0) * f, by = y0 + (y1 - y0) * f;
    // the needle's centre sits half a needle away from the branch so it starts at the bark
    addLeaf(t, bx + Math.sin(a) * leafSize * 0.5, by - Math.cos(a) * leafSize * 0.5, a - Math.PI / 2, 0.9 + rnd() * 0.3);
  }
}

/** Curved tapered trunk and a crown of drooping fronds with leaflets on both sides. */
function growPalm(t) {
  const { sp, rnd, baseX, baseY, treeH, trunkW } = t;
  const segs = 8, lean = (rnd() - 0.5) * 0.5;
  let x = baseX, y = baseY, a = lean * 0.3;
  for (let i = 0; i < segs; i++) {
    const len = treeH / segs;
    a = lean * 0.3 + lean * (i / segs) * 0.8;
    const nx = x + Math.sin(a) * len, ny = y - Math.cos(a) * len;
    const w0 = trunkW * (1 - (i / segs) * 0.4), w1 = trunkW * (1 - ((i + 1) / segs) * 0.4);
    t.branches.push({ x0: x, y0: y, x1: nx, y1: ny, w0, w1, level: 0 });
    x = nx;
    y = ny;
  }
  const topX = x, topY = y;
  const n = sp.fronds + Math.floor(rnd() * 3);
  const stemRGB = [(t.branchRGB[0] + t.leafRGB[0]) / 2, (t.branchRGB[1] + t.leafRGB[1]) / 2, (t.branchRGB[2] + t.leafRGB[2]) / 2];
  for (let k = 0; k < n; k++) {
    let ang = ((k / n) - 0.5) * 2 * (100 * DEG) + (rnd() - 0.5) * 0.3; // from straight up to past horizontal on both sides
    const dir = ang >= 0 ? 1 : -1;
    const steps = 10, total = treeH * (0.32 + rnd() * 0.12), segLen = total / steps;
    let px = topX, py = topY;
    for (let i = 0; i < steps; i++) {
      ang += dir * 0.16; // gravity bends the frond down
      const nx = px + Math.sin(ang) * segLen, ny = py - Math.cos(ang) * segLen;
      t.branches.push({ x0: px, y0: py, x1: nx, y1: ny, w0: 2.4 - i * 0.16, w1: 2.2 - i * 0.16, level: 1, rgb: stemRGB });
      if (t.leafKind !== 'none' && t.amount > 0) {
        const m = Math.max(1, Math.round(2 * t.amount));
        for (let j = 0; j < m; j++) {
          const f = (j + 0.5) / m, scale = (1.3 - i * 0.07) * (0.8 + rnd() * 0.3);
          const bx = px + (nx - px) * f, by = py + (ny - py) * f;
          for (const side of [1, -1]) {
            const la = ang + side * (50 + rnd() * 20) * DEG;
            const cx = bx + Math.sin(la) * t.leafSize * 0.6 * scale, cy = by - Math.cos(la) * t.leafSize * 0.6 * scale;
            addLeaf(t, cx, cy, la - Math.PI / 2, scale);
          }
        }
      }
      px = nx;
      py = ny;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Flame

export const FLAME_TYPES = Object.freeze(['one-flame', 'multiple-flames-along-path', 'multiple-flames-one-direction', 'multiple-flames-path-directed', 'multiple-flames-various-angle', 'candle-light']);
const FLAME_OCTAVES = { draft: 1, low: 2, medium: 3, high: 4, fine: 5 };

const ptX = (p) => (Array.isArray(p) ? p[0] : p.x);
const ptY = (p) => (Array.isArray(p) ? p[1] : p.y);

/**
 * Flattens PathData ({ subpaths: [{ points: [{ x, y, inX?, inY?, outX?, outY? } | [x, y]], closed }] })
 * into polylines [[x, y], ...]; cubic segments are sampled by length. Exported for the dialog.
 */
export function flattenPath(path) {
  const out = [];
  if (!path || !Array.isArray(path.subpaths)) return out;
  for (const sp of path.subpaths) {
    const pts = sp?.points;
    if (!Array.isArray(pts) || pts.length < 2) continue;
    const poly = [[ptX(pts[0]), ptY(pts[0])]];
    const last = sp.closed ? pts.length : pts.length - 1;
    for (let i = 1; i <= last; i++) {
      const a = pts[i - 1], b = pts[i % pts.length];
      const ax = ptX(a), ay = ptY(a), bx = ptX(b), by = ptY(b);
      const c1x = a.outX ?? ax, c1y = a.outY ?? ay, c2x = b.inX ?? bx, c2y = b.inY ?? by;
      if (c1x === ax && c1y === ay && c2x === bx && c2y === by) {
        poly.push([bx, by]);
        continue;
      }
      const n = clampI(Math.ceil((Math.hypot(c1x - ax, c1y - ay) + Math.hypot(c2x - c1x, c2y - c1y) + Math.hypot(bx - c2x, by - c2y)) / 6), 4, 64);
      for (let k = 1; k <= n; k++) {
        const u = k / n, v = 1 - u;
        poly.push([v * v * v * ax + 3 * v * v * u * c1x + 3 * v * u * u * c2x + u * u * u * bx, v * v * v * ay + 3 * v * v * u * c1y + 3 * v * u * u * c2y + u * u * u * by]);
      }
    }
    if (poly.length >= 2) out.push(poly);
  }
  return out;
}

/** Flame body half-width profile along t (0 base .. 1 tip): a teardrop, widest a fifth of the way up. */
const flameProfile = (t, candle) => (t < 0.2 ? Math.sqrt(t / 0.2) : Math.pow(1 - (t - 0.2) / 0.8, candle ? 1.0 : 1.3));

/** Default fire ramp by heat 0..1: transparent dark red -> red -> orange -> yellow -> white. */
function fireColor(h, out, custom) {
  if (custom) {
    // white-hot core fading through the chosen colour to its darker shade
    const k = h < 0.5 ? h / 0.5 : 1;
    const w = h > 0.75 ? (h - 0.75) / 0.25 : 0;
    out[0] = (custom[0] * k * (1 - w) + 255 * w) / 255;
    out[1] = (custom[1] * k * (1 - w) + 255 * w) / 255;
    out[2] = (custom[2] * k * (1 - w) + 255 * w) / 255;
    return out;
  }
  if (h > 0.8) {
    const k = (h - 0.8) / 0.2;
    out[0] = 1;
    out[1] = 0.86 + 0.12 * k;
    out[2] = 0.3 + 0.6 * k;
  } else if (h > 0.5) {
    const k = (h - 0.5) / 0.3;
    out[0] = 1;
    out[1] = 0.5 + 0.36 * k;
    out[2] = 0.08 + 0.22 * k;
  } else if (h > 0.2) {
    const k = (h - 0.2) / 0.3;
    out[0] = 0.8 + 0.2 * k;
    out[1] = 0.16 + 0.34 * k;
    out[2] = 0.03 + 0.05 * k;
  } else {
    const k = h / 0.2;
    out[0] = 0.45 + 0.35 * k;
    out[1] = 0.05 + 0.11 * k;
    out[2] = 0.02 + 0.01 * k;
  }
  return out;
}

/** Lighter-colour accumulation ("plus lighter" with union alpha): overlapping flames add up like light. */
function addLight(acc, o, r, g, b, a) {
  acc[o] = Math.min(1, acc[o] + r * a);
  acc[o + 1] = Math.min(1, acc[o + 1] + g * a);
  acc[o + 2] = Math.min(1, acc[o + 2] + b * a);
  acc[o + 3] = 1 - (1 - acc[o + 3]) * (1 - a);
}

/**
 * Evaluates one flame body for the pixel at (t along 0..1, s across in half-widths) and adds it to
 * the scene. Returns nothing; the caller supplies the noise seed per emitter.
 */
function flamePixel(F, o, x, y, t, s, nz) {
  const { acc, turb, jag, oct, candle, opacity, custom, col } = F;
  // turbulence bends the flame sideways, more toward the tip; a second field stretches it along
  const tt = t + (fbm(x * 0.03, y * 0.03, nz + 5, oct) - 0.5) * (0.08 + turb * 0.4);
  if (tt < 0 || tt > 1) return;
  const ss = s + (fbm(x * 0.02 * (1 + turb), y * 0.02, nz, oct) - 0.5) * 2 * (0.15 + turb * 1.5) * t;
  // jag tears the outline with high-frequency noise
  const edge = flameProfile(tt, candle) * (1 + jag * (fbm(x * 0.15, y * 0.15, nz + 9, 2) - 0.5) * 1.4);
  if (edge <= 0.001) return;
  let dens = 1 - Math.abs(ss) / edge;
  if (dens <= 0) return;
  dens = smoothstep(0, 0.6, dens) * (1 - tt * 0.35);
  const heat = clampNum(dens * (1 - tt * 0.45) + 0.3 * (1 - Math.abs(ss)) * (1 - tt), 0, 1);
  fireColor(heat, col, custom);
  addLight(acc, o, col[0], col[1], col[2], clampNum(dens * 1.4, 0, 1) * opacity);
}

/** One flame whose spine is the whole polyline: nearest-point distance field over the path's neighbourhood. */
function flameAlongPath(F, poly, nz) {
  const { r } = F;
  const halfW = F.width / 2, pad = halfW * (1.6 + F.jag) + 2;
  // arc lengths
  const segLen = [], acc = [0];
  let total = 0;
  for (let i = 1; i < poly.length; i++) {
    const l = Math.hypot(poly[i][0] - poly[i - 1][0], poly[i][1] - poly[i - 1][1]);
    segLen.push(l);
    total += l;
    acc.push(total);
  }
  if (total <= 0) return;
  let xa = Infinity, ya = Infinity, xb = -Infinity, yb = -Infinity;
  for (const [x, y] of poly) {
    if (x < xa) xa = x;
    if (x > xb) xb = x;
    if (y < ya) ya = y;
    if (y > yb) yb = y;
  }
  const gx0 = clampI(Math.floor(xa - pad), r.x, r.x + r.width), gx1 = clampI(Math.ceil(xb + pad) + 1, r.x, r.x + r.width);
  const gy0 = clampI(Math.floor(ya - pad), r.y, r.y + r.height), gy1 = clampI(Math.ceil(yb + pad) + 1, r.y, r.y + r.height);
  const gw = gx1 - gx0, gh = gy1 - gy0;
  if (gw <= 0 || gh <= 0) return;
  const dist = new Float32Array(gw * gh).fill(Infinity), tF = new Float32Array(gw * gh), sF = new Float32Array(gw * gh);
  for (let i = 1; i < poly.length; i++) {
    const [x0, y0] = poly[i - 1], [x1, y1] = poly[i], l = segLen[i - 1];
    if (l <= 0) continue;
    const ux = (x1 - x0) / l, uy = (y1 - y0) / l;
    const bx0 = clampI(Math.floor(Math.min(x0, x1) - pad), gx0, gx1), bx1 = clampI(Math.ceil(Math.max(x0, x1) + pad) + 1, gx0, gx1);
    const by0 = clampI(Math.floor(Math.min(y0, y1) - pad), gy0, gy1), by1 = clampI(Math.ceil(Math.max(y0, y1) + pad) + 1, gy0, gy1);
    for (let y = by0; y < by1; y++) {
      const ry = y + 0.5 - y0;
      for (let x = bx0; x < bx1; x++) {
        const rx = x + 0.5 - x0;
        const t = rx * ux + ry * uy, tc = t < 0 ? 0 : t > l ? l : t;
        const qx = rx - ux * tc, qy = ry - uy * tc, dd = qx * qx + qy * qy;
        const o = (y - gy0) * gw + (x - gx0);
        if (dd < dist[o]) {
          dist[o] = dd;
          tF[o] = (acc[i - 1] + tc) / total;
          sF[o] = (rx * -uy + ry * ux) / halfW;
        }
      }
    }
  }
  for (let y = gy0; y < gy1; y++) {
    for (let x = gx0; x < gx1; x++) {
      const o = (y - gy0) * gw + (x - gx0);
      if (dist[o] === Infinity) continue;
      flamePixel(F, ((y - r.y) * r.width + (x - r.x)) * 4, x, y, tF[o], sF[o], nz);
    }
  }
}

/** A straight flame rising from (bx, by) in direction (dx, dy) for len px. */
function flameEmitter(F, bx, by, dx, dy, len, width, nz) {
  const { r } = F;
  const halfW = width / 2, px = -dy, py = dx;
  const pad = halfW * (1.6 + F.jag) + 2;
  const ex = bx + dx * len, ey = by + dy * len;
  const xa = clampI(Math.floor(Math.min(bx, ex) - pad - len * 0.1), r.x, r.x + r.width), xb = clampI(Math.ceil(Math.max(bx, ex) + pad + len * 0.1) + 1, r.x, r.x + r.width);
  const ya = clampI(Math.floor(Math.min(by, ey) - pad - len * 0.1), r.y, r.y + r.height), yb = clampI(Math.ceil(Math.max(by, ey) + pad + len * 0.1) + 1, r.y, r.y + r.height);
  for (let y = ya; y < yb; y++) {
    const ry = y + 0.5 - by;
    for (let x = xa; x < xb; x++) {
      const rx = x + 0.5 - bx;
      const t = (rx * dx + ry * dy) / len;
      if (t < -0.1 || t > 1.1) continue;
      const s = (rx * px + ry * py) / halfW;
      if (Math.abs(s) > 1.6 + F.jag) continue;
      flamePixel(F, ((y - r.y) * r.width + (x - r.x)) * 4, x, y, t, s, nz);
    }
  }
}

function flame(img, p, rect) {
  const r = region(img, rect);
  if (isEmpty(r)) return img;
  const polys = flattenPath(p.path);
  if (!polys.length) return img; // the dialog toasts "Draw a path first"; a replay without a path is a no-op
  const type = FLAME_TYPES.includes(p.flameType) ? p.flameType : 'one-flame';
  const seed = num(p.seed, 1) | 0;
  const rnd = randomSeeded(hash3(seed, 0xf1a, 3) || 1);
  const length = clampNum(num(p.length, 100), 5, 300), width = Math.max(1, clampNum(num(p.width, 50), 1, 100));
  const angle = num(p.angle, 0) * DEG, interval = Math.max(0, num(p.interval, 50));
  const randL = clampNum(num(p.randomizeLength, 0), 0, 100) / 100, randI = clampNum(num(p.randomizeInterval, 0), 0, 100) / 100;
  const s = makeScene(r);
  const F = {
    acc: s.acc, r,
    turb: clampNum(num(p.turbulence, 0), 0, 100) / 100,
    jag: clampNum(num(p.jag, 0), 0, 100) / 100,
    oct: FLAME_OCTAVES[p.quality] ?? 3,
    candle: type === 'candle-light',
    opacity: clampNum(num(p.opacity, 50), 0, 100) / 100 * 1.6, // 50 % reads as a full flame, 100 % saturates the core
    custom: p.useCustomColor ? rgbOf(p.color, '#ff8c00') : null,
    col: [0, 0, 0],
    width,
  };
  if (type === 'one-flame') {
    polys.forEach((poly, i) => flameAlongPath(F, poly, seed * 7 + i * 17));
    return overRegion(img, r, s.acc);
  }
  // emitters spaced along the path by arc length
  const step = Math.max(interval, width * 0.5, 3);
  let n = 0;
  for (const poly of polys) {
    let carry = step * 0.5 * (1 + (rnd() - 0.5) * randI);
    for (let i = 1; i < poly.length; i++) {
      const [x0, y0] = poly[i - 1], [x1, y1] = poly[i];
      const l = Math.hypot(x1 - x0, y1 - y0);
      if (l <= 0) continue;
      const tx = (x1 - x0) / l, ty = (y1 - y0) / l;
      let pos = carry;
      while (pos <= l) {
        const bx = x0 + tx * pos, by = y0 + ty * pos;
        let dx, dy;
        if (type === 'multiple-flames-one-direction') {
          dx = Math.sin(angle);
          dy = -Math.cos(angle);
        } else if (type === 'multiple-flames-path-directed') {
          dx = tx;
          dy = ty;
        } else if (type === 'multiple-flames-various-angle') {
          const a = angle + (rnd() - 0.5) * TAU;
          dx = Math.sin(a);
          dy = -Math.cos(a);
        } else if (type === 'candle-light') {
          dx = 0;
          dy = -1;
        } else {
          // along the path: flames stand on the path's normal, the one pointing up when the path is horizontal
          dx = -ty;
          dy = tx;
          if (dy > 0 || (dy === 0 && dx < 0)) {
            dx = -dx;
            dy = -dy;
          }
        }
        const len = Math.max(3, length * (1 + (rnd() - 0.5) * 1.6 * randL));
        flameEmitter(F, bx, by, dx, dy, len, F.candle ? width * 0.7 : width, seed * 7 + n * 13);
        n++;
        pos += step * (1 + (rnd() - 0.5) * 1.6 * randI);
        if (n > 4000) break; // a safety net for absurd intervals on long paths
      }
      carry = pos - l;
    }
  }
  return overRegion(img, r, s.acc);
}

// ---------------------------------------------------------------------------------------------
// Picture Frame

export const FRAME_TYPES = Object.freeze(['vines', 'leaves', 'flowers', 'geometric', 'bamboo', 'rope', 'wood', 'film', 'stars', 'circles']);

/** Coverage of a disc / rotated ellipse at offset (dx, dy), anti-aliased by half a pixel. */
const ellipseCover = (dx, dy, rx, ry, ang) => {
  const c = Math.cos(ang), sn = Math.sin(ang);
  const lx = dx * c + dy * sn, ly = -dx * sn + dy * c;
  const e = Math.sqrt((lx * lx) / (rx * rx) + (ly * ly) / (ry * ry));
  return clampNum((1 - e) * Math.max(0.5, Math.min(rx, ry)) + 0.5, 0, 1);
};

/** Five-point star coverage (linear radius between the inner and outer points). */
function starCover(dx, dy, R, rot) {
  const d = Math.hypot(dx, dy);
  if (d > R + 1) return 0;
  const a = Math.atan2(dy, dx) - rot;
  const f = Math.abs(((((a * 5) / TAU) % 1) + 1) % 1 - 0.5) * 2; // 0 at an inner point, 1 at an outer point
  const rr = R * (0.42 + 0.58 * f);
  return clampNum(rr - d + 0.5, 0, 1);
}

/** Period that divides the edge length evenly, near the wanted spacing. */
const periodFor = (len, want) => len / Math.max(1, Math.round(len / want));

/**
 * Motif colour at (u along the edge, v inward from the image edge) for frame type `type`.
 * Writes straight RGB 0..1 and coverage into out[0..3]. `e` is the edge index (0 left, 1 top,
 * 2 right, 3 bottom), `len` the edge length, bw the border width.
 */
function frameMotif(type, u, v, e, len, bw, seed, c1, c2, out) {
  out[3] = 0;
  const mid = bw / 2;
  switch (type) {
    case 'vines': {
      const P = periodFor(len, bw * 2.4);
      const v0 = mid + bw * 0.22 * Math.sin((u / P) * TAU);
      const stem = clampNum(bw * 0.07 + 0.5 - Math.abs(v - v0), 0, 1);
      if (stem > 0) {
        out[0] = c1[0]; out[1] = c1[1]; out[2] = c1[2]; out[3] = stem;
      }
      // leaves every half period on alternating sides of the stem
      const k0 = Math.round((u - P / 4) / (P / 2));
      for (let k = k0 - 1; k <= k0 + 1; k++) {
        const uk = k * (P / 2) + P / 4, side = k % 2 === 0 ? 1 : -1;
        const vk = mid + bw * 0.22 * Math.sin((uk / P) * TAU) + side * bw * 0.2;
        const cov = ellipseCover(u - uk, v - vk, bw * 0.24, bw * 0.12, side * 0.8);
        if (cov > out[3]) {
          const sh = 0.85 + 0.15 * lat(k, e, seed);
          out[0] = c2[0] * sh; out[1] = c2[1] * sh; out[2] = c2[2] * sh; out[3] = cov;
        }
      }
      return;
    }
    case 'leaves': {
      const P = periodFor(len, bw * 0.75);
      const k0 = Math.round(u / P);
      for (let k = k0 + 1; k >= k0 - 1; k--) {
        const uk = k * P, tiltA = (k % 2 === 0 ? 1 : -1) * 0.35;
        const cov = ellipseCover(u - uk, v - mid, bw * 0.55, bw * 0.3, tiltA);
        if (cov > 0) {
          // central vein, darker near the stalk
          const c = Math.cos(tiltA), sn = Math.sin(tiltA);
          const ly = -(u - uk) * sn + (v - mid) * c, lx = (u - uk) * c + (v - mid) * sn;
          const vein = Math.abs(ly) < bw * 0.025 ? 0.55 : 1;
          const sh = (0.75 + 0.25 * (lx / (bw * 0.55) + 1) * 0.5) * vein * (0.9 + 0.1 * lat(k, e, seed));
          out[0] = c2[0] * sh; out[1] = c2[1] * sh; out[2] = c2[2] * sh; out[3] = cov;
          return;
        }
      }
      return;
    }
    case 'flowers': {
      const P = periodFor(len, bw * 1.1);
      const stem = clampNum(bw * 0.05 + 0.5 - Math.abs(v - mid - bw * 0.12 * Math.sin((u / P) * Math.PI)), 0, 1);
      if (stem > 0) {
        out[0] = c2[0]; out[1] = c2[1]; out[2] = c2[2]; out[3] = stem;
      }
      const k0 = Math.round(u / P);
      for (let k = k0 - 1; k <= k0 + 1; k++) {
        const uk = k * P, dx = u - uk, dy = v - mid, d = Math.hypot(dx, dy), R = bw * 0.4;
        if (d > R + 1) continue;
        const th = Math.atan2(dy, dx) + lat(k, e, seed) * TAU;
        const rr = R * (0.68 + 0.32 * Math.cos(5 * th));
        const petal = clampNum(rr - d + 0.5, 0, 1);
        if (petal > 0) {
          const light = k % 2 === 0 ? 1 : 0.8;
          out[0] = c1[0] * light + (1 - light) * 1; out[1] = c1[1] * light + (1 - light); out[2] = c1[2] * light + (1 - light); out[3] = Math.max(out[3], petal);
        }
        const centre = clampNum(R * 0.24 - d + 0.5, 0, 1);
        if (centre > 0) {
          out[0] = 1; out[1] = 0.85; out[2] = 0.2; out[3] = Math.max(out[3], centre);
        }
      }
      return;
    }
    case 'geometric': {
      // a solid band: thin rails along both sides and a row of alternating triangles between them
      if (v > bw) return;
      const rail = v < bw * 0.1 || v > bw * 0.9;
      if (rail) {
        out[0] = c1[0]; out[1] = c1[1]; out[2] = c1[2]; out[3] = 1;
        return;
      }
      const P = periodFor(len, bw * 0.8), fu = ((u % P) + P) % P / P, fv = (v - bw * 0.1) / (bw * 0.8);
      const k = Math.floor(u / P);
      const tri = (k % 2 === 0 ? fu : 1 - fu) < fv;
      const c = tri ? c1 : c2;
      out[0] = c[0]; out[1] = c[1]; out[2] = c[2]; out[3] = 1;
      return;
    }
    case 'bamboo': {
      if (v > bw) return;
      const t = (v - mid) / mid, cyl = Math.sqrt(Math.max(0, 1 - t * t));
      let sh = 0.45 + 0.55 * cyl;
      const P = periodFor(len, bw * 2.4), fu = ((u % P) + P) % P;
      if (fu < bw * 0.14) sh *= 0.6; // the node ring
      else if (fu < bw * 0.22) sh *= 1.12;
      sh *= 0.95 + 0.1 * vnoise(u * 0.05, v * 0.2, seed + e);
      out[0] = c1[0] * sh; out[1] = c1[1] * sh; out[2] = c1[2] * sh; out[3] = clampNum(bw - v + 0.5, 0, 1);
      return;
    }
    case 'rope': {
      const t = (v - mid) / mid, cyl = Math.sqrt(Math.max(0, 1 - t * t));
      if (cyl <= 0) return;
      // two strands twisted round each other: a diagonal sine across the band
      const tw = Math.sin(((u / (bw * 0.55)) + t * 0.8) * Math.PI);
      const sh = (0.4 + 0.6 * cyl) * (0.65 + 0.35 * Math.abs(tw)) * (0.92 + 0.08 * vnoise(u * 0.3, v * 0.3, seed + e));
      out[0] = c1[0] * sh; out[1] = c1[1] * sh; out[2] = c1[2] * sh; out[3] = clampNum(cyl * mid + 0.5, 0, 1);
      return;
    }
    case 'wood': {
      if (v > bw) return;
      const grain = fbm(u * 0.015, v * 0.1, seed + 13 + e, 3);
      let sh = 0.78 + 0.3 * grain;
      if (v < bw * 0.12) sh *= 1.15; // bevel: light outer lip, dark inner lip
      else if (v > bw * 0.88) sh *= 0.7;
      out[0] = c1[0] * sh; out[1] = c1[1] * sh; out[2] = c1[2] * sh; out[3] = 1;
      return;
    }
    case 'film': {
      if (v > bw) return;
      // dark strip with sprocket holes along both edges (transparent) and a thin inner rail
      const P = periodFor(len, bw * 0.5), fu = ((u % P) + P) % P - P / 2;
      const hole = (vc) => Math.abs(fu) < bw * 0.11 && Math.abs(v - vc) < bw * 0.1;
      if (hole(bw * 0.22) || hole(bw * 0.78)) return;
      const rail = Math.abs(v - mid) < bw * 0.02;
      const c = rail ? c2 : c1;
      const sh = rail ? 1 : 0.35;
      out[0] = c[0] * sh; out[1] = c[1] * sh; out[2] = c[2] * sh; out[3] = 1;
      return;
    }
    case 'stars': {
      const P = periodFor(len, bw * 0.8);
      const k0 = Math.floor(u / P);
      for (let k = k0 - 1; k <= k0 + 1; k++) {
        const j1 = lat(k, e, seed), j2 = lat(k, e, seed + 1), j3 = lat(k, e, seed + 2);
        const R = bw * (0.17 + 0.17 * j3);
        const uc = (k + 0.5) * P + (j1 - 0.5) * P * 0.5, vc = R + (bw - 2 * R) * j2;
        const cov = starCover(u - uc, v - vc, R, j1 * TAU);
        if (cov > out[3]) {
          const c = k % 2 === 0 ? c1 : c2;
          out[0] = c[0]; out[1] = c[1]; out[2] = c[2]; out[3] = cov;
        }
      }
      return;
    }
    case 'circles':
    default: {
      const P = periodFor(len, bw * 0.7);
      const k0 = Math.round(u / P);
      for (let k = k0 - 1; k <= k0 + 1; k++) {
        const uk = k * P, d = Math.hypot(u - uk, v - mid), R = bw * 0.3;
        let cov;
        if (k % 2 === 0) cov = clampNum(R - d + 0.5, 0, 1);
        else cov = Math.min(clampNum(R - d + 0.5, 0, 1), clampNum(d - R * 0.72 + 0.5, 0, 1)); // ring
        if (cov > out[3]) {
          const c = k % 2 === 0 ? c1 : c2;
          out[0] = c[0]; out[1] = c[1]; out[2] = c[2]; out[3] = cov;
        }
        // small dot between the big ones
        const dm = Math.hypot(u - uk - P / 2, v - mid), small = clampNum(bw * 0.07 - dm + 0.5, 0, 1);
        if (small > out[3]) {
          out[0] = c2[0]; out[1] = c2[1]; out[2] = c2[2]; out[3] = small;
        }
      }
    }
  }
}

function pictureFrame(img, p, rect) {
  const r = region(img, rect);
  if (isEmpty(r)) return img;
  const W = img.width, H = img.height, shorter = Math.min(W, H);
  const size = clampNum(num(p.size, 100), 0, 100);
  if (size <= 0) return img;
  const bw = Math.max(2, shorter * 0.12 * (size / 100));
  const type = FRAME_TYPES.includes(p.frame) ? p.frame : 'vines';
  const seed = num(p.seed, 1) | 0;
  const c1 = rgbOf(p.color, '#8d6e63').map((v) => v / 255), c2 = rgbOf(p.secondaryColor, '#4caf50').map((v) => v / 255);
  const acc = new Float32Array(r.width * r.height * 4);
  const out = [0, 0, 0, 0];
  const reach = bw * 1.1 + 2; // motifs may poke slightly past the band
  for (let y = r.y; y < r.y + r.height; y++) {
    const dt = y + 0.5, db = H - y - 0.5;
    for (let x = r.x; x < r.x + r.width; x++) {
      const dl = x + 0.5, dr = W - x - 0.5;
      // the nearest image edge owns the pixel, which mitres the corners
      let v = dl, e = 0, u = y + 0.5, len = H;
      if (dt < v) { v = dt; e = 1; u = x + 0.5; len = W; }
      if (dr < v) { v = dr; e = 2; u = y + 0.5; len = H; }
      if (db < v) { v = db; e = 3; u = x + 0.5; len = W; }
      if (v >= reach) continue;
      frameMotif(type, u, v, e, len, bw, seed, c1, c2, out);
      if (out[3] <= 0) continue;
      over(acc, ((y - r.y) * r.width + (x - r.x)) * 4, out[0], out[1], out[2], out[3]);
    }
  }
  return overRegion(img, r, acc);
}

// ---------------------------------------------------------------------------------------------
// Extrude

/**
 * Fills a convex polygon (points [[x, y], ...]) into out (W x H bytes) inside rect r.
 * shade(x, y, px) writes the pixel's RGBA at byte index px.
 */
function fillConvex(out, W, pts, r, shade) {
  let ya = Infinity, yb = -Infinity;
  for (const [, y] of pts) {
    if (y < ya) ya = y;
    if (y > yb) yb = y;
  }
  const y0 = Math.max(r.y, Math.floor(ya)), y1 = Math.min(r.y + r.height - 1, Math.ceil(yb));
  const n = pts.length;
  for (let y = y0; y <= y1; y++) {
    const cy = y + 0.5;
    let xl = Infinity, xr = -Infinity;
    for (let i = 0; i < n; i++) {
      const [ax, ay] = pts[i], [bx, by] = pts[(i + 1) % n];
      if ((cy >= ay && cy < by) || (cy >= by && cy < ay)) {
        const x = ax + ((cy - ay) * (bx - ax)) / (by - ay);
        if (x < xl) xl = x;
        if (x > xr) xr = x;
      }
    }
    if (xl === Infinity) continue;
    const xs = Math.max(r.x, Math.ceil(xl - 0.5)), xe = Math.min(r.x + r.width - 1, Math.floor(xr - 0.5));
    for (let x = xs; x <= xe; x++) shade(x, y, (y * W + x) * 4);
  }
}

function extrude(img, p, rect) {
  const r = region(img, rect);
  if (isEmpty(r)) return img;
  const W = img.width, H = img.height, d = img.data, src = new Uint8ClampedArray(d);
  const size = clampI(Math.round(num(p.size, 30)), 2, 255), depth = clampNum(num(p.depth, 30), 1, 255);
  const pyramids = p.type === 'pyramids', levelBased = p.depthMode === 'level-based', solid = !!p.solidFront, maskInc = p.maskIncomplete !== false;
  const seed = num(p.seed, 1) | 0;
  const cx = W / 2, cy = H / 2, F = 0.75 * Math.max(W, H); // a block of height h scales by 1 + h / F about the centre
  const cols = Math.ceil(W / size), rows = Math.ceil(H / size);
  const cells = [];
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const x0 = i * size, y0 = j * size, x1 = Math.min(W, x0 + size), y1 = Math.min(H, y0 + size);
      if (maskInc && (x1 - x0 !== size || y1 - y0 !== size)) continue;
      let sr = 0, sg = 0, sb = 0, sa = 0, cnt = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0, q = (y * W + x0) * 4; x < x1; x++, q += 4) {
          const a = src[q + 3];
          sr += src[q] * a;
          sg += src[q + 1] * a;
          sb += src[q + 2] * a;
          sa += a;
          cnt++;
        }
      }
      const mr = sa ? sr / sa : 0, mg = sa ? sg / sa : 0, mb = sa ? sb / sa : 0, ma = cnt ? sa / cnt : 0;
      const h = levelBased ? depth * (luminance(mr, mg, mb) / 255) : depth * lat(i, j, seed);
      const ccx = (x0 + x1) / 2, ccy = (y0 + y1) / 2;
      cells.push({ x0, y0, x1, y1, h, mr, mg, mb, ma, ccx, ccy, dist: Math.hypot(ccx - cx, ccy - cy) });
    }
  }
  // blocks nearer the viewing axis occlude those behind them: paint far cells first
  cells.sort((a, b) => b.dist - a.dist);
  const light = normalize3(-0.5, -0.7, 0.55);
  const proj = (x, y, k) => [cx + (x - cx) * k, cy + (y - cy) * k];
  const shadeOf = (nx, ny, nz) => {
    const ndl = nx * light[0] + ny * light[1] + nz * light[2];
    return 0.3 + 0.7 * (ndl > 0 ? ndl : 0);
  };
  const solidFill = (c, sh) => {
    const rr = round8(c.mr * sh), gg = round8(c.mg * sh), bb = round8(c.mb * sh), aa = round8(c.ma);
    return (x, y, q) => {
      d[q] = rr;
      d[q + 1] = gg;
      d[q + 2] = bb;
      d[q + 3] = aa;
    };
  };
  for (const c of cells) {
    const k = 1 + c.h / F;
    const B = [[c.x0, c.y0], [c.x1, c.y0], [c.x1, c.y1], [c.x0, c.y1]];
    if (pyramids) {
      const A = proj(c.ccx, c.ccy, k);
      // four triangular faces; those facing the axis are painted last (they are in front)
      const faces = [];
      for (let i = 0; i < 4; i++) {
        const a = B[i], b = B[(i + 1) % 4];
        const ex = b[0] - a[0], ey = b[1] - a[1], l = Math.hypot(ex, ey) || 1;
        const onx = ey / l, ony = -ex / l; // outward normal of this base edge
        const toAxis = (cx - c.ccx) * onx + (cy - c.ccy) * ony;
        const n = normalize3(onx * c.h, ony * c.h, size / 2);
        faces.push({ pts: [a, b, A], sh: shadeOf(n[0], n[1], n[2]), toAxis });
      }
      faces.sort((f1, f2) => f1.toAxis - f2.toAxis);
      for (const f of faces) fillConvex(d, W, f.pts, r, solidFill(c, f.sh));
      continue;
    }
    const T = B.map(([x, y]) => proj(x, y, k));
    for (let i = 0; i < 4; i++) {
      const a = B[i], b = B[(i + 1) % 4];
      const ex = b[0] - a[0], ey = b[1] - a[1], l = Math.hypot(ex, ey) || 1;
      const onx = ey / l, ony = -ex / l;
      // only the side faces turned toward the viewing axis show between the base and the raised top
      if ((cx - c.ccx) * onx + (cy - c.ccy) * ony <= 0) continue;
      fillConvex(d, W, [a, b, T[(i + 1) % 4], T[i]], r, solidFill(c, shadeOf(onx, ony, 0)));
    }
    if (solid) fillConvex(d, W, T, r, solidFill(c, 1));
    else {
      const ik = 1 / k;
      fillConvex(d, W, T, r, (x, y, q) => {
        // the top face carries the cell's own pixels, scaled up with the block
        const sx = clampI(Math.floor(cx + (x + 0.5 - cx) * ik), c.x0, c.x1 - 1), sy = clampI(Math.floor(cy + (y + 0.5 - cy) * ik), c.y0, c.y1 - 1);
        const s = (sy * W + sx) * 4;
        d[q] = src[s];
        d[q + 1] = src[s + 1];
        d[q + 2] = src[s + 2];
        d[q + 3] = src[s + 3];
      });
    }
  }
  return img;
}

// ---------------------------------------------------------------------------------------------
// Tiles

function tiles(img, p, rect) {
  const r = region(img, rect);
  if (isEmpty(r)) return img;
  const W = img.width, H = img.height, d = img.data, src = new Uint8ClampedArray(d);
  const count = clampI(Math.round(num(p.count, 10)), 1, 99), off = clampNum(num(p.offset, 10), 0, 99) / 100;
  const ts = Math.max(1, Math.ceil(Math.min(W, H) / count));
  const cols = Math.ceil(W / ts), rows = Math.ceil(H / ts);
  const seed = num(p.seed, 1) | 0;
  const [fg, bg] = colorsOf(p, '#000000', '#ffffff');
  // the gaps: background / foreground colour, the inverted image, or the image as it is
  const fill = p.fill;
  if (fill === 'inverse') {
    for (let y = r.y; y < r.y + r.height; y++) {
      for (let x = r.x, i = (y * W + r.x) * 4; x < r.x + r.width; x++, i += 4) {
        d[i] = 255 - src[i];
        d[i + 1] = 255 - src[i + 1];
        d[i + 2] = 255 - src[i + 2];
      }
    }
  } else if (fill !== 'unaltered') {
    const c = fill === 'foreground' ? fg : bg;
    for (let y = r.y; y < r.y + r.height; y++) {
      for (let x = r.x, i = (y * W + r.x) * 4; x < r.x + r.width; x++, i += 4) {
        d[i] = c[0];
        d[i + 1] = c[1];
        d[i + 2] = c[2];
        d[i + 3] = 255;
      }
    }
  }
  // every tile's offset comes from the same stream in row-major order, so the layout is independent of rect
  const rnd = randomSeeded(hash3(seed, 0x7117e5, cols * 31 + rows) || 1);
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const dx = Math.round((rnd() * 2 - 1) * off * ts), dy = Math.round((rnd() * 2 - 1) * off * ts);
      const x0 = i * ts, y0 = j * ts, x1 = Math.min(W, x0 + ts), y1 = Math.min(H, y0 + ts);
      const ax = Math.max(r.x, x0 + dx), bx = Math.min(r.x + r.width, x1 + dx);
      const ay = Math.max(r.y, y0 + dy), by = Math.min(r.y + r.height, y1 + dy);
      if (ax >= bx || ay >= by) continue;
      for (let y = ay; y < by; y++) {
        const s = ((y - dy) * W + (ax - dx)) * 4;
        d.set(src.subarray(s, s + (bx - ax) * 4), (y * W + ax) * 4);
      }
    }
  }
  return img;
}

// ---------------------------------------------------------------------------------------------
// Trace Contour

function traceContour(img, p, rect) {
  const r = region(img, rect);
  if (isEmpty(r)) return img;
  const W = img.width, H = img.height, d = img.data, src = new Uint8ClampedArray(d);
  const level = clampI(Math.round(num(p.level, 128)), 0, 255), lower = p.edge !== 'upper';
  for (let y = r.y; y < r.y + r.height; y++) {
    const up = y > 0 ? -W * 4 : 0, down = y < H - 1 ? W * 4 : 0;
    for (let x = r.x, i = (y * W + r.x) * 4; x < r.x + r.width; x++, i += 4) {
      const left = x > 0 ? -4 : 0, right = x < W - 1 ? 4 : 0;
      for (let c = 0; c < 3; c++) {
        const v = src[i + c];
        let mark = false;
        if (lower) {
          // the pixel just below the level next to one at or above it
          if (v < level) mark = src[i + c + left] >= level || src[i + c + right] >= level || src[i + c + up] >= level || src[i + c + down] >= level;
        } else if (v >= level) mark = src[i + c + left] < level || src[i + c + right] < level || src[i + c + up] < level || src[i + c + down] < level;
        // Photoshop zeroes the channel on its contour: a red-channel edge shows cyan, all three show black
        d[i + c] = mark ? 0 : 255;
      }
    }
  }
  return img;
}

// ---------------------------------------------------------------------------------------------
// Wind

function wind(img, p, rect) {
  const r = region(img, rect);
  if (isEmpty(r)) return img;
  const W = img.width, H = img.height, d = img.data, src = new Uint8ClampedArray(d);
  const method = p.method === 'blast' ? 'blast' : p.method === 'stagger' ? 'stagger' : 'wind';
  const toRight = p.direction !== 'left';
  const seed = num(p.seed, 1) | 0;
  const minLen = method === 'blast' ? 24 : 4, maxLen = method === 'blast' ? 72 : 14;
  const stag = method === 'stagger' ? 3 : 0;
  // stagger writes a streak a few rows off its source row, so source rows just outside rect matter
  const ya = Math.max(0, r.y - stag), yb = Math.min(H, r.y + r.height + stag);
  for (let y = ya; y < yb; y++) {
    const rnd = randomSeeded(rowSeed(seed, method === 'blast' ? 2 : method === 'stagger' ? 3 : 1, y));
    let cl = -1, cr = 0, cg = 0, cb = 0, ca = 0, n = 0, total = 1, row = y;
    // walk the whole row downwind so the state inside rect matches a whole-image run
    for (let k = 0; k < W; k++) {
      const x = toRight ? k : W - 1 - k, i = (y * W + x) * 4;
      const a = src[i + 3], pl = (luminance(src[i], src[i + 1], src[i + 2]) * a) / 255;
      if (cl < 0 || pl >= cl - 10) {
        // brighter (or as bright): the wind picks this pixel up; no streak is visible here
        cl = pl;
        cr = src[i];
        cg = src[i + 1];
        cb = src[i + 2];
        ca = a;
        n = 0;
        continue;
      }
      if (n === 0 && pl < cl - 10 && k > 0 && src[(y * W + (toRight ? x - 1 : x + 1)) * 4 + 3] === ca && Math.abs(cl - pl) > 10) {
        // a drop in brightness just downwind of a lit pixel: most of them shed a streak
        if (rnd() < 0.7) {
          total = n = minLen + Math.floor(rnd() * (maxLen - minLen + 1));
          row = stag ? clampI(y + Math.floor(rnd() * (2 * stag + 1)) - stag, 0, H - 1) : y;
        } else {
          cl = pl;
          continue;
        }
      }
      if (n > 0) {
        const str = (n / total) * 0.95;
        n--;
        if (row >= r.y && row < r.y + r.height && x >= r.x && x < r.x + r.width) {
          const o = (row * W + x) * 4;
          const ol = (luminance(d[o], d[o + 1], d[o + 2]) * d[o + 3]) / 255;
          if (cl * str > ol) {
            d[o] = round8(d[o] + (cr - d[o]) * str);
            d[o + 1] = round8(d[o + 1] + (cg - d[o + 1]) * str);
            d[o + 2] = round8(d[o + 2] + (cb - d[o + 2]) * str);
            d[o + 3] = Math.max(d[o + 3], round8(ca * str));
          }
        }
        if (n === 0) cl = pl; // the streak ends: whatever is here becomes the carried brightness
      } else cl = pl;
    }
  }
  return img;
}

// ---------------------------------------------------------------------------------------------
// Catalogue

const S = (key, label, min, max, step = 1, extra = {}) => ({ key, label, type: 'slider', min, max, step, ...extra });
const SEED = { key: 'seed', label: 'Seed', type: 'number', min: 0, max: 99999 };
const title = (s) => s.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

export const FILTERS_MORE_B = Object.freeze({
  // distort
  displace: defineFilter('Displace', 'distort', { horizontalScale: 10, verticalScale: 10, mapMode: 'stretch', edge: 'repeat', map: null }, displace, {
    ui: 'custom', // lib/filters-b-ui.js adds the displacement map chooser above these fields
    incomplete: (p) => !p?.map, // a replay without its map (Last Filter, actions) re-opens the chooser instead of a no-op
    fields: [
      S('horizontalScale', 'Horizontal scale', -999, 999, 1, { unit: '%' }),
      S('verticalScale', 'Vertical scale', -999, 999, 1, { unit: '%' }),
      { key: 'mapMode', label: 'Displacement map', type: 'segment', options: [['stretch', 'Stretch to fit'], ['tile', 'Tile']] },
      { key: 'edge', label: 'Undefined areas', type: 'segment', options: [['wrap', 'Wrap around'], ['repeat', 'Repeat edge pixels']] },
    ],
    margin: (p) => Math.ceil(Math.max(Math.abs(num(p.horizontalScale, 0)), Math.abs(num(p.verticalScale, 0)))) + 1,
  }),
  // render
  fibers: defineFilter('Fibers', 'render', { variance: 16, strength: 4, seed: 1, colors: ['#000000', '#ffffff'] }, fibers, {
    fields: [S('variance', 'Variance', 1, 64), S('strength', 'Strength', 1, 64), { key: 'colors.0', label: 'Color 1', type: 'color' }, { key: 'colors.1', label: 'Color 2', type: 'color' }, SEED],
    margin: 0,
  }),
  'lighting-effects': defineFilter('Lighting Effects', 'render', { lights: [{ type: 'spot', x: 0.5, y: 0.5, intensity: 35, hotspot: 69, color: '#ffffff', angle: 0, radius: 0.6, focus: 0.3, exposure: 0 }], ambient: 0, ambientColor: '#ffffff', exposure: 0, gloss: 0, metallic: 69, texture: 'none', height: 50, whiteIsHigh: true }, lightingEffects, {
    fields: [
      { key: 'lights.0.type', label: 'Light', type: 'segment', options: [['spot', 'Spot'], ['point', 'Point'], ['infinite', 'Infinite']] },
      S('lights.0.x', 'Position X', -0.5, 1.5, 0.01), S('lights.0.y', 'Position Y', -0.5, 1.5, 0.01),
      S('lights.0.intensity', 'Intensity', -100, 100), S('lights.0.hotspot', 'Hotspot', 0, 100), S('lights.0.angle', 'Angle', 0, 360, 1, { unit: '°' }),
      S('lights.0.radius', 'Radius', 0.05, 2, 0.01), S('lights.0.focus', 'Focus', 0, 1, 0.01), S('lights.0.exposure', 'Light exposure', -100, 100),
      { key: 'lights.0.color', label: 'Light color', type: 'color' },
      { label: 'Properties', type: 'section' },
      S('gloss', 'Gloss', -100, 100), S('metallic', 'Metallic', -100, 100), S('exposure', 'Exposure', -100, 100), S('ambient', 'Ambience', -100, 100),
      { key: 'ambientColor', label: 'Ambient color', type: 'color' },
      { key: 'texture', label: 'Texture channel', type: 'select', options: [['none', 'None'], ['red', 'Red'], ['green', 'Green'], ['blue', 'Blue'], ['alpha', 'Transparency'], ['luminance', 'Luminance']] },
      S('height', 'Height', 0, 100), { key: 'whiteIsHigh', label: 'White is high', type: 'checkbox' },
    ],
    margin: 1,
  }),
  tree: defineFilter('Tree', 'render', { type: 'oak', lightDirection: 90, cameraTilt: 0, leavesAmount: 70, leavesSize: 100, branchesHeight: 160, branchesThickness: 100, defaultLeaves: true, seed: 1, arrangement: 1, leafColor: DEFAULT_LEAF, branchColor: DEFAULT_BRANCH }, tree, {
    fields: [
      { key: 'type', label: 'Base tree type', type: 'select', options: TREE_TYPES.map((t) => [t, title(t)]) },
      S('lightDirection', 'Light direction', 0, 180, 1, { unit: '°' }), S('cameraTilt', 'Camera tilt', 0, 60, 1, { unit: '°' }),
      S('leavesAmount', 'Leaves amount', 0, 100), S('leavesSize', 'Leaves size', 0, 200, 1, { unit: '%' }),
      S('branchesHeight', 'Branches height', 70, 300, 1, { unit: '%' }), S('branchesThickness', 'Branches thickness', 0, 200, 1, { unit: '%' }),
      { key: 'defaultLeaves', label: 'Default leaves', type: 'checkbox' },
      { key: 'arrangement', label: 'Arrangement', type: 'number', min: 1, max: 999 },
      { key: 'leafColor', label: 'Leaves color', type: 'color' }, { key: 'branchColor', label: 'Branches color', type: 'color' }, SEED,
    ],
    margin: 0,
  }),
  flame: defineFilter('Flame', 'render', { flameType: 'one-flame', length: 100, width: 50, angle: 0, interval: 50, randomizeLength: 0, randomizeInterval: 0, quality: 'medium', turbulence: 0, jag: 0, opacity: 50, color: '#ff8c00', useCustomColor: false, seed: 1, path: null }, flame, {
    ui: 'custom', // lib/filters-b-ui.js fetches the work path / shape path into params.path
    fields: [
      { key: 'flameType', label: 'Flame type', type: 'select', options: FLAME_TYPES.map((t) => [t, title(t)]) },
      S('length', 'Length', 5, 300), S('width', 'Width', 1, 100), S('angle', 'Angle', 0, 360, 1, { unit: '°' }), S('interval', 'Interval', 1, 300),
      S('randomizeLength', 'Randomize length', 0, 100), S('randomizeInterval', 'Randomize interval', 0, 100),
      { key: 'quality', label: 'Quality', type: 'select', options: [['draft', 'Draft'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['fine', 'Fine']] },
      S('turbulence', 'Turbulence', 0, 100), S('jag', 'Jag', 0, 100), S('opacity', 'Opacity', 0, 100),
      { key: 'useCustomColor', label: 'Use custom color', type: 'checkbox' }, { key: 'color', label: 'Flame color', type: 'color', when: (v) => !!v.useCustomColor }, SEED,
    ],
    margin: 0,
  }),
  'picture-frame': defineFilter('Picture Frame', 'render', { frame: 'vines', size: 100, color: '#8d6e63', secondaryColor: '#4caf50', seed: 1 }, pictureFrame, {
    fields: [
      { key: 'frame', label: 'Frame', type: 'select', options: FRAME_TYPES.map((t) => [t, title(t)]) },
      S('size', 'Size', 1, 100), { key: 'color', label: 'Color', type: 'color' }, { key: 'secondaryColor', label: 'Secondary color', type: 'color' }, SEED,
    ],
    margin: 0,
  }),
  // stylize
  extrude: defineFilter('Extrude', 'stylize', { type: 'blocks', size: 30, depth: 30, depthMode: 'random', solidFront: false, maskIncomplete: true, seed: 1 }, extrude, {
    fields: [
      { key: 'type', label: 'Type', type: 'segment', options: [['blocks', 'Blocks'], ['pyramids', 'Pyramids']] },
      S('size', 'Size', 2, 255, 1, { unit: 'px' }), S('depth', 'Depth', 1, 255),
      { key: 'depthMode', label: 'Depth', type: 'segment', options: [['random', 'Random'], ['level-based', 'Level-based']] },
      { key: 'solidFront', label: 'Solid front faces', type: 'checkbox' }, { key: 'maskIncomplete', label: 'Mask incomplete blocks', type: 'checkbox' }, SEED,
    ],
    margin: (p) => Math.ceil(clampNum(num(p.depth, 30), 1, 255) * 1.5) + clampNum(num(p.size, 30), 2, 255),
  }),
  tiles: defineFilter('Tiles', 'stylize', { count: 10, offset: 10, fill: 'background', seed: 1, colors: ['#000000', '#ffffff'] }, tiles, {
    fields: [
      S('count', 'Number of tiles', 1, 99), S('offset', 'Maximum offset', 1, 99, 1, { unit: '%' }),
      { key: 'fill', label: 'Fill empty area with', type: 'select', options: [['background', 'Background color'], ['foreground', 'Foreground color'], ['inverse', 'Inverse image'], ['unaltered', 'Unaltered image']] },
      { key: 'colors.0', label: 'Foreground', type: 'color', when: (v) => v.fill === 'foreground' }, { key: 'colors.1', label: 'Background', type: 'color', when: (v) => v.fill === 'background' }, SEED,
    ],
    margin: 400,
  }),
  'trace-contour': defineFilter('Trace Contour', 'stylize', { level: 128, edge: 'lower' }, traceContour, {
    fields: [S('level', 'Level', 0, 255), { key: 'edge', label: 'Edge', type: 'segment', options: [['lower', 'Lower'], ['upper', 'Upper']] }],
    margin: 1,
  }),
  wind: defineFilter('Wind', 'stylize', { method: 'wind', direction: 'right', seed: 1 }, wind, {
    fields: [
      { key: 'method', label: 'Method', type: 'segment', options: [['wind', 'Wind'], ['blast', 'Blast'], ['stagger', 'Stagger']] },
      { key: 'direction', label: 'Direction', type: 'segment', options: [['right', 'From the left'], ['left', 'From the right']] },
      SEED,
    ],
    margin: (p) => (p.method === 'blast' ? 80 : 20),
  }),
});
