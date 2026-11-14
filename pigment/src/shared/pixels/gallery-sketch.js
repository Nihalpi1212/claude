// Filter Gallery kinds, part B (builder "gallery-b"): the Sketch, Texture and Distort groups of the
// gallery (Diffuse Glow, Glass and Ocean Ripple live only in the gallery in Photoshop). Sketch kinds
// paint with the foreground and background colours: params.colors = ['#rrggbb' fg, '#rrggbb' bg]
// is filled in by the dialogs from the current colours (lib/gallery-b-ui.js for the plain filter
// dialog, lib/filter-gallery.js for the gallery; defaults black on white). Chrome is grey and Water
// Paper keeps the image's colours, as in Photoshop. Same conventions as filters.js: rect limits
// writes only (neighbourhoods, noise and cell grids use whole-image coordinates, so a partial
// repaint matches a full one), straight alpha in and out, alpha-weighted averaging where colours
// are pooled (Patchwork, Stained Glass), deterministic noise per seed. `fields` and `margin` are
// pure data lib/filter-ui.js and the Filter Gallery dialog read.
//
// Toolkit (module private): luminance maps, a three-pass box blur (≈ Gaussian), Sobel slopes,
// position-stable hash noise (white, smooth lattice, oriented strokes), a jittered-grid Voronoi
// (nearest two seeds) for cells and cracks, two-tone painting and the texture relief from textures.js.

import { clampRect, inflateRect, cropImage, sampleBilinear } from './core.js';
import { parseColor } from './color.js';
import { num, clampNum, smoothstep, region, isEmptyRegion, defineFilter } from './filter-def.js';
import { texture, relief, heightFromImage, smoothHeight, LIGHT_DIRECTIONS } from './textures.js';

/** @typedef {import('./core.js').ImageDataLike} ImageDataLike */
/** @typedef {import('./core.js').Rect} Rect */

export const COLORS = Object.freeze(['#000000', '#ffffff']);
export const STROKE_DIRECTIONS = Object.freeze(['right-diagonal', 'horizontal', 'left-diagonal', 'vertical']);
export const PATTERN_TYPES = Object.freeze(['circle', 'dot', 'line']);
export const GRAIN_TYPES = Object.freeze(['regular', 'soft', 'sprinkles', 'clumped', 'contrasty', 'enlarged', 'stippled', 'horizontal', 'vertical', 'speckle']);
export const GLASS_TEXTURES = Object.freeze(['blocks', 'canvas', 'frosted', 'tiny-lens']);
export const SURFACE_TEXTURES = Object.freeze(['brick', 'burlap', 'canvas', 'sandstone']);
/** Glass moves a pixel by at most GLASS_PX_PER_UNIT * distortion px (the texture slope is at most 1/2 per px, times 6). */
export const GLASS_PX_PER_UNIT = 3;
/** Ocean Ripple moves a pixel by at most RIPPLE_PX_PER_UNIT * rippleMagnitude px. */
export const RIPPLE_PX_PER_UNIT = 2;

// ---------------------------------------------------------------------------------------------
// Toolkit

const grow = (img, r, px) => clampRect(inflateRect(r, Math.ceil(px)), img.width, img.height);

/** Copies the r part of sub (an image covering region g of img) back into img. */
function copyBack(img, sub, g, r) {
  const row = r.width * 4, W = img.width;
  for (let y = r.y; y < r.y + r.height; y++) {
    const s = ((y - g.y) * sub.width + (r.x - g.x)) * 4;
    img.data.set(sub.data.subarray(s, s + row), (y * W + r.x) * 4);
  }
}

/**
 * Working copy of rect grown by `margin` (what a neighbourhood effect reads); done() writes the
 * rect part back. Effects keep whole-image coordinates through g.x / g.y for noise and cells.
 */
function workspace(img, rect, margin) {
  const r = region(img, rect);
  if (isEmptyRegion(r)) return null;
  const g = grow(img, r, margin);
  const sub = cropImage(img, g);
  return { r, g, sub, done: () => copyBack(img, sub, g, r) };
}

/** Luminance (0..255) of every pixel, straight colour (alpha is kept separately by the callers). */
function luma(img) {
  const d = img.data, out = new Float32Array(img.width * img.height);
  for (let i = 0, p = 0; p < out.length; p++, i += 4) out[p] = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
  return out;
}

/** Three-pass box blur of a float map (≈ Gaussian of sigma ≈ radius·0.9), edges replicated, in place. */
function blur(map, w, h, radius) {
  const r = Math.round(radius);
  if (r <= 0 || map.length !== w * h) return map;
  const tmp = new Float32Array(map.length);
  const inv = 1 / (2 * r + 1);
  for (let pass = 0; pass < 3; pass++) {
    for (let y = 0; y < h; y++) {
      const row = y * w;
      let sum = 0;
      for (let k = -r; k <= r; k++) sum += map[row + (k < 0 ? 0 : k >= w ? w - 1 : k)];
      for (let x = 0; x < w; x++) {
        tmp[row + x] = sum * inv;
        sum += map[row + (x + r + 1 >= w ? w - 1 : x + r + 1)] - map[row + (x - r <= 0 ? 0 : x - r)];
      }
    }
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let k = -r; k <= r; k++) sum += tmp[(k < 0 ? 0 : k >= h ? h - 1 : k) * w + x];
      for (let y = 0; y < h; y++) {
        map[y * w + x] = sum * inv;
        sum += tmp[(y + r + 1 >= h ? h - 1 : y + r + 1) * w + x] - tmp[(y - r <= 0 ? 0 : y - r) * w + x];
      }
    }
  }
  return map;
}

/** Blurred copy of a map (the original is kept). */
const blurred = (map, w, h, radius) => blur(Float32Array.from(map), w, h, radius);

/** Central-difference slopes of a map (per px, in the map's units): { gx, gy }. */
function slopes(map, w, h) {
  const gx = new Float32Array(map.length), gy = new Float32Array(map.length);
  for (let y = 0; y < h; y++) {
    const yu = (y > 0 ? y - 1 : 0) * w, yd = (y < h - 1 ? y + 1 : h - 1) * w, row = y * w;
    for (let x = 0; x < w; x++) {
      const xl = x > 0 ? x - 1 : 0, xr = x < w - 1 ? x + 1 : w - 1;
      gx[row + x] = (map[row + xr] - map[row + xl]) / 2;
      gy[row + x] = (map[yd + x] - map[yu + x]) / 2;
    }
  }
  return { gx, gy };
}

/** Sobel gradient magnitude of a map (0..~4·range). */
function edges(map, w, h) {
  const out = new Float32Array(map.length);
  for (let y = 0; y < h; y++) {
    const yu = (y > 0 ? y - 1 : 0) * w, yd = (y < h - 1 ? y + 1 : h - 1) * w, row = y * w;
    for (let x = 0; x < w; x++) {
      const xl = x > 0 ? x - 1 : 0, xr = x < w - 1 ? x + 1 : w - 1;
      const gx = map[yu + xr] + 2 * map[row + xr] + map[yd + xr] - map[yu + xl] - 2 * map[row + xl] - map[yd + xl];
      const gy = map[yd + xl] + 2 * map[yd + x] + map[yd + xr] - map[yu + xl] - 2 * map[yu + x] - map[yu + xr];
      out[row + x] = Math.sqrt(gx * gx + gy * gy) / 4;
    }
  }
  return out;
}

/** Integer hash of three int32s to 0..1 (position-stable white noise). */
function hash3(x, y, z) {
  let h = (Math.imul(x | 0, 0x27d4eb2d) + Math.imul(y | 0, 0x165667b1) + Math.imul(z | 0, 0x9e3779b1)) | 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/** White noise map over a region at whole-image offset (ox, oy). */
function whiteNoise(w, h, seed, ox, oy) {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] = hash3(x + ox, y + oy, seed);
  return out;
}

/** Smooth lattice noise (cell px, Hermite interpolation) over a region at whole-image offset, 0..1. */
function smoothNoise(w, h, cell, seed, ox, oy) {
  const out = new Float32Array(w * h);
  const inv = 1 / Math.max(1, cell);
  for (let y = 0; y < h; y++) {
    const fy = (y + oy) * inv, y0 = Math.floor(fy);
    let ty = fy - y0;
    ty = ty * ty * (3 - 2 * ty);
    for (let x = 0; x < w; x++) {
      const fx = (x + ox) * inv, x0 = Math.floor(fx);
      let tx = fx - x0;
      tx = tx * tx * (3 - 2 * tx);
      const a = hash3(x0, y0, seed), b = hash3(x0 + 1, y0, seed), c = hash3(x0, y0 + 1, seed), d = hash3(x0 + 1, y0 + 1, seed);
      out[y * w + x] = (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
    }
  }
  return out;
}

/** Fractal lattice noise (octaves halving the cell), normalised to 0..1. */
function fractalNoise(w, h, cell, seed, ox, oy, octaves = 3) {
  const out = new Float32Array(w * h);
  let amp = 1, total = 0, c = cell;
  for (let o = 0; o < octaves && c >= 1; o++) {
    const n = smoothNoise(w, h, c, seed + o * 31, ox, oy);
    for (let i = 0; i < out.length; i++) out[i] += n[i] * amp;
    total += amp;
    amp *= 0.5;
    c /= 2;
  }
  for (let i = 0; i < out.length; i++) out[i] /= total;
  return out;
}

const STROKE_VECTORS = { 'right-diagonal': [1, -1], horizontal: [1, 0], 'left-diagonal': [1, 1], vertical: [0, 1] };

/**
 * Oriented stroke texture: white noise smeared along `direction` over `length` px, then contrast
 * stretched back to about 0..1 (a line integral of noise has a smaller spread), so a threshold on
 * it gives pen or chalk strokes. Position stable except within `length` of the region edge.
 */
function strokeNoise(w, h, length, direction, seed, ox, oy) {
  const n = whiteNoise(w, h, seed, ox, oy);
  const len = Math.max(1, Math.round(length));
  if (len <= 1) return n;
  const [vx, vy] = STROKE_VECTORS[direction] ?? STROKE_VECTORS['right-diagonal'];
  const out = new Float32Array(w * h);
  const half = len >> 1;
  let mean = 0, sq = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0, count = 0;
      for (let k = -half; k <= half; k++) {
        const xx = x + k * vx, yy = y + k * vy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        sum += n[yy * w + xx];
        count++;
      }
      const v = sum / count;
      out[y * w + x] = v;
      mean += v;
      sq += v * v;
    }
  }
  // stretch: mean 0.5, spread like white noise (std 0.29)
  mean /= out.length;
  const std = Math.sqrt(Math.max(1e-6, sq / out.length - mean * mean));
  const k = 0.2887 / std;
  for (let i = 0; i < out.length; i++) out[i] = 0.5 + (out[i] - mean) * k;
  return out;
}

/**
 * Jittered-grid Voronoi over a region at whole-image offset: per pixel the distance to the nearest
 * seed (f1), to the second (f2), the nearest seed's grid cell id and the vector towards it.
 * `jitter` 0..1 moves seeds off the cell centres (0 = a square grid).
 */
function voronoi(w, h, cell, jitter, seed, ox, oy) {
  const n = w * h;
  const f1 = new Float32Array(n), f2 = new Float32Array(n), id = new Int32Array(n), dirx = new Float32Array(n), diry = new Float32Array(n);
  const c = Math.max(1, cell);
  for (let y = 0; y < h; y++) {
    const py = y + oy, cy = Math.floor(py / c);
    for (let x = 0; x < w; x++) {
      const px = x + ox, cx = Math.floor(px / c);
      let d1 = Infinity, d2 = Infinity, best = 0, bx = 0, by = 0;
      for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
        const gx = cx + i, gy = cy + j;
        const sx = (gx + 0.5 + (hash3(gx, gy, seed) - 0.5) * jitter) * c;
        const sy = (gy + 0.5 + (hash3(gx, gy, seed + 77) - 0.5) * jitter) * c;
        const dx = sx - px, dy = sy - py;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < d1) {
          d2 = d1;
          d1 = d;
          best = gx * 73856093 ^ gy * 19349663;
          bx = dx;
          by = dy;
        } else if (d < d2) d2 = d;
      }
      const p = y * w + x;
      f1[p] = d1;
      f2[p] = d2;
      id[p] = best;
      const inv = d1 > 0 ? 1 / d1 : 0;
      dirx[p] = bx * inv;
      diry[p] = by * inv;
    }
  }
  return { f1, f2, id, dirx, diry };
}

/** [r, g, b] 0..255 of a CSS colour (fallback black). */
const rgb = (c, fallback = [0, 0, 0]) => {
  const p = parseColor(c, null);
  return p ? [p[0], p[1], p[2]] : fallback;
};
const colorsOf = (p) => {
  const c = Array.isArray(p.colors) ? p.colors : COLORS;
  return [rgb(c[0], [0, 0, 0]), rgb(c[1] ?? COLORS[1], [255, 255, 255])];
};
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Paints pixel i of img with lerp(fg, bg, t) (t 0 = foreground, 1 = background); alpha kept. */
function paint(d, i, fg, bg, t) {
  d[i] = fg[0] + (bg[0] - fg[0]) * t;
  d[i + 1] = fg[1] + (bg[1] - fg[1]) * t;
  d[i + 2] = fg[2] + (bg[2] - fg[2]) * t;
}

const dirVector = (name) => {
  const v = { top: [0, -1], 'top-left': [-0.7071, -0.7071], left: [-1, 0], 'bottom-left': [-0.7071, 0.7071], bottom: [0, 1], 'bottom-right': [0.7071, 0.7071], right: [1, 0], 'top-right': [0.7071, -0.7071] }[name];
  return v ?? [0, -1];
};

/** The height map of a texture kind over the whole image, cropped to region g (position stable). */
function textureFor(p, img, g, seed = 1) {
  const W = img.width, H = img.height;
  const map = p.textureImage && p.textureImage.data
    ? heightFromImage(p.textureImage, W, H, { scaling: p.scaling })
    : texture(p.texture, W, H, { scaling: p.scaling, seed });
  if (g.x === 0 && g.y === 0 && g.width === W && g.height === H) return map;
  const out = new Uint8ClampedArray(g.width * g.height);
  for (let y = 0; y < g.height; y++) out.set(map.subarray((g.y + y) * W + g.x, (g.y + y) * W + g.x + g.width), y * g.width);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Sketch

function basRelief(img, p, rect) {
  const smooth = clampNum(num(p.smoothness, 3), 1, 15), detail = clampNum(num(p.detail, 13), 1, 15);
  const ws = workspace(img, rect, smooth * 2 + 2);
  if (!ws) return img;
  const { sub } = ws, w = sub.width, h = sub.height, d = sub.data;
  const L = blur(luma(sub), w, h, smooth * 0.5);
  const { gx, gy } = slopes(L, w, h);
  const [lx, ly] = dirVector(p.lightDirection);
  const [fg, bg] = colorsOf(p);
  // a carved surface: the slope facing the light is lit (background), the slope away is in shadow
  // (foreground); detail scales the slope; a little of the tone itself keeps large areas apart
  const k = detail * 1.2;
  for (let i = 0, q = 0; q < L.length; q++, i += 4) {
    const slope = (gx[q] * -lx + gy[q] * -ly) / 255;
    paint(d, i, fg, bg, clamp01(0.5 + slope * k + (L[q] / 255 - 0.5) * 0.3));
  }
  ws.done();
  return img;
}

function chalkCharcoal(img, p, rect) {
  const charcoal = clampNum(num(p.charcoalArea, 6), 0, 20), chalk = clampNum(num(p.chalkArea, 6), 0, 20), pressure = clampNum(num(p.strokePressure, 1), 0, 5);
  const seed = num(p.seed, 1) | 0;
  const ws = workspace(img, rect, 12);
  if (!ws) return img;
  const { sub, g } = ws, w = sub.width, h = sub.height, d = sub.data;
  const L = blur(luma(sub), w, h, 1);
  const sC = strokeNoise(w, h, 10, 'right-diagonal', seed, g.x, g.y);
  const sK = strokeNoise(w, h, 10, 'left-diagonal', seed + 5, g.x, g.y);
  const [fg, bg] = colorsOf(p);
  // the midtones are solid 50% grey; charcoal (foreground) covers the shadows up to a level set by
  // its area, chalk (background) the highlights; pressure sharpens the stroke edges
  const darkT = (charcoal / 20) * 0.6, lightT = 1 - (chalk / 20) * 0.6;
  const k = 2.5 + pressure * 0.6;
  for (let i = 0, q = 0; q < L.length; q++, i += 4) {
    const v = L[q] / 255;
    const c = clamp01((darkT - v) * k + 0.5 + (sC[q] - 0.5) * 0.5);
    const kc = clamp01((v - lightT) * k + 0.5 + (sK[q] - 0.5) * 0.5);
    let r = 128, gg = 128, b = 128;
    r += (fg[0] - r) * c;
    gg += (fg[1] - gg) * c;
    b += (fg[2] - b) * c;
    d[i] = r + (bg[0] - r) * kc;
    d[i + 1] = gg + (bg[1] - gg) * kc;
    d[i + 2] = b + (bg[2] - b) * kc;
  }
  ws.done();
  return img;
}

function charcoal(img, p, rect) {
  const thick = clampNum(num(p.charcoalThickness, 1), 1, 7), detail = clampNum(num(p.detail, 5), 0, 5), balance = clampNum(num(p.lightDarkBalance, 50), 0, 100);
  const ws = workspace(img, rect, thick * 3 + 8);
  if (!ws) return img;
  const { sub, g } = ws, w = sub.width, h = sub.height, d = sub.data;
  const L = blur(luma(sub), w, h, thick * 0.75);
  const E = edges(L, w, h);
  const s = strokeNoise(w, h, 6, 'right-diagonal', 3, g.x, g.y);
  const [fg, bg] = colorsOf(p);
  const bias = ((balance - 50) / 100) * 1.2, ek = (detail / 5) * 1.5;
  for (let i = 0, q = 0; q < L.length; q++, i += 4) {
    const ink = 1 - L[q] / 255 + bias + (E[q] / 255) * ek;
    const cover = clamp01((ink - 0.5) * 2.5 + 0.5 + (s[q] - 0.5) * 0.5);
    paint(d, i, fg, bg, 1 - cover);
  }
  ws.done();
  return img;
}

function chrome(img, p, rect) {
  const detail = clampNum(num(p.detail, 4), 0, 10), smooth = clampNum(num(p.smoothness, 7), 0, 10);
  const ws = workspace(img, rect, smooth * 2 + 4);
  if (!ws) return img;
  const { sub } = ws, w = sub.width, h = sub.height, d = sub.data;
  const L = blur(luma(sub), w, h, smooth * 0.8 + 0.5);
  const { gx, gy } = slopes(L, w, h);
  // liquid metal: the tone is folded into reflection bands (more with detail) and the surface
  // slope adds a specular highlight from the top left; the result is grey, as in Photoshop
  const bands = 1 + detail * 0.5;
  const sk = 0.08 + smooth * 0.01;
  for (let i = 0, q = 0; q < L.length; q++, i += 4) {
    const v = L[q] / 255;
    const nx = -gx[q] * sk, ny = -gy[q] * sk;
    const inv = 1 / Math.sqrt(nx * nx + ny * ny + 1);
    const ndl = (nx * -0.57 + ny * -0.57 + 0.57) * inv;
    const spec = ndl > 0 ? ndl ** 10 : 0;
    const wave = 0.5 + 0.5 * Math.sin((v * bands + nx * 2) * Math.PI * 2 - Math.PI / 2);
    const grey = clamp01(0.15 + wave * 0.6 + spec * 0.45 + v * 0.1) * 255;
    d[i] = d[i + 1] = d[i + 2] = grey;
  }
  ws.done();
  return img;
}

function conteCrayon(img, p, rect) {
  const fgLevel = clampNum(num(p.foregroundLevel, 11), 1, 15), bgLevel = clampNum(num(p.backgroundLevel, 7), 1, 15);
  const ws = workspace(img, rect, 3);
  if (!ws) return img;
  const { sub, g, r } = ws, w = sub.width, h = sub.height, d = sub.data;
  const L = blur(luma(sub), w, h, 1);
  const grain = whiteNoise(w, h, 9, g.x, g.y);
  const [fg, bg] = colorsOf(p);
  // crayon on grey paper: the foreground colour covers the shadows (more with its level), the
  // background colour the highlights; the paper texture then lights the strokes
  for (let i = 0, q = 0; q < L.length; q++, i += 4) {
    const v = L[q] / 255, gr = 0.75 + 0.25 * grain[q];
    const c = clamp01(((1 - v) * (fgLevel / 15) * 1.7 - 0.12) * gr);
    const k = clamp01((v * (bgLevel / 15) * 1.7 - 0.12) * gr);
    let rr = 128, gg = 128, bb = 128;
    rr += (fg[0] - rr) * c;
    gg += (fg[1] - gg) * c;
    bb += (fg[2] - bb) * c;
    d[i] = rr + (bg[0] - rr) * k;
    d[i + 1] = gg + (bg[1] - gg) * k;
    d[i + 2] = bb + (bg[2] - bb) * k;
  }
  relief(sub, textureFor({ ...p, texture: SURFACE_TEXTURES.includes(p.texture) ? p.texture : 'sandstone' }, img, g), { relief: clampNum(num(p.relief, 4), 0, 50), lightDirection: p.lightDirection, invert: !!p.invert, rect: { x: r.x - g.x, y: r.y - g.y, width: r.width, height: r.height } });
  ws.done();
  return img;
}

function graphicPen(img, p, rect) {
  const length = clampNum(num(p.strokeLength, 15), 1, 15), balance = clampNum(num(p.lightDarkBalance, 50), 0, 100);
  const seed = num(p.seed, 1) | 0;
  const ws = workspace(img, rect, length * 1.5 + 2);
  if (!ws) return img;
  const { sub, g } = ws, w = sub.width, h = sub.height, d = sub.data;
  const L = luma(sub);
  const s = strokeNoise(w, h, length * 1.5 + 1, STROKE_DIRECTIONS.includes(p.strokeDirection) ? p.strokeDirection : 'right-diagonal', seed, g.x, g.y);
  const [fg, bg] = colorsOf(p);
  // fine ink strokes: a pixel is inked where the stroke texture falls under the local darkness
  const bias = (balance - 50) / 100;
  for (let i = 0, q = 0; q < L.length; q++, i += 4) {
    const ink = 1 - L[q] / 255 + bias;
    paint(d, i, fg, bg, s[q] < ink ? 0 : 1);
  }
  ws.done();
  return img;
}

function halftonePattern(img, p, rect) {
  const size = clampNum(num(p.size, 1), 1, 12), contrast = clampNum(num(p.contrast, 5), 0, 50);
  const type = PATTERN_TYPES.includes(p.patternType) ? p.patternType : 'dot';
  const r = region(img, rect);
  if (isEmptyRegion(r)) return img;
  const W = img.width, H = img.height, d = img.data;
  const [fg, bg] = colorsOf(p);
  const cell = 3 + size * 2;
  const gain = 1 + contrast / 10, soft = 0.5 - contrast / 100;
  const cx = W / 2, cy = H / 2;
  for (let y = r.y; y < r.y + r.height; y++) {
    for (let x = r.x; x < r.x + r.width; x++) {
      const i = (y * W + x) * 4;
      const v = 0.5 + ((d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 255000 - 0.5) * gain;
      // the screen: a threshold map whose area fraction below t is about t, so tone maps to coverage
      let q;
      if (type === 'line') q = Math.abs((((y % cell) + 0.5) / cell) * 2 - 1);
      else if (type === 'circle') {
        const dist = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) / cell;
        q = Math.abs((dist - Math.floor(dist)) * 2 - 1);
      } else {
        const dx = ((x % cell) + 0.5) / cell - 0.5, dy = ((y % cell) + 0.5) / cell - 0.5;
        q = (dx * dx + dy * dy) * 2;
      }
      const t = soft > 0.001 ? smoothstep(q - soft, q + soft, v) : v > q ? 1 : 0;
      paint(d, i, fg, bg, t);
    }
  }
  return img;
}

function notePaper(img, p, rect) {
  const balance = clampNum(num(p.imageBalance, 25), 0, 50), grainAmt = clampNum(num(p.graininess, 10), 0, 20), reliefAmt = clampNum(num(p.relief, 11), 0, 25);
  const seed = num(p.seed, 1) | 0;
  const ws = workspace(img, rect, 6);
  if (!ws) return img;
  const { sub, g, r } = ws, w = sub.width, h = sub.height, d = sub.data;
  const L = blur(luma(sub), w, h, 1.5);
  const grain = whiteNoise(w, h, seed, g.x, g.y);
  const [fg, bg] = colorsOf(p);
  const thr = balance / 50;
  const height = new Uint8ClampedArray(w * h);
  // two sheets of paper: the light areas are the raised top sheet (background colour), the dark
  // areas show the sheet below (foreground); grain speckles both and roughens the relief
  for (let i = 0, q = 0; q < L.length; q++, i += 4) {
    const m = smoothstep(thr - 0.04, thr + 0.04, L[q] / 255);
    const gr = (grain[q] - 0.5) * (grainAmt / 20);
    paint(d, i, fg, bg, clamp01(m + gr * 0.5));
    height[q] = (0.2 + 0.6 * m + gr * 0.6) * 255;
  }
  relief(sub, height, { relief: reliefAmt * 2, lightDirection: 'top-left', rect: { x: r.x - g.x, y: r.y - g.y, width: r.width, height: r.height } });
  ws.done();
  return img;
}

function photocopy(img, p, rect) {
  const detail = clampNum(num(p.detail, 7), 1, 24), darkness = clampNum(num(p.darkness, 8), 1, 50);
  const R = 3 + (24 - detail);
  const ws = workspace(img, rect, R * 3 + 2);
  if (!ws) return img;
  const { sub } = ws, w = sub.width, h = sub.height, d = sub.data;
  const L = luma(sub);
  const B = blurred(L, w, h, R);
  const [fg, bg] = colorsOf(p);
  // toner sticks where a pixel is darker than its surroundings (the edges of dark areas) and, a
  // little, in the deepest shadows; the middle of a large dark area comes out mostly paper
  const k = darkness * 0.45;
  for (let i = 0, q = 0; q < L.length; q++, i += 4) {
    const v = L[q] / 255;
    const local = (B[q] - L[q]) / 255;
    const ink = local * k + (1 - smoothstep(0, 0.3, v)) * 0.4 * (darkness / 25);
    paint(d, i, fg, bg, 1 - clamp01(ink));
  }
  ws.done();
  return img;
}

function plaster(img, p, rect) {
  const balance = clampNum(num(p.imageBalance, 20), 0, 50), smooth = clampNum(num(p.smoothness, 2), 1, 15);
  const ws = workspace(img, rect, smooth * 3 + 4);
  if (!ws) return img;
  const { sub, g, r } = ws, w = sub.width, h = sub.height, d = sub.data;
  const L = blur(luma(sub), w, h, smooth * 0.8);
  const [fg, bg] = colorsOf(p);
  const thr = balance / 50;
  const height = new Float32Array(w * h);
  // moulded plaster: the dark areas are raised (foreground colour), the light ones recessed
  // (background); the slopes between them catch the light from the chosen direction
  for (let q = 0; q < L.length; q++) height[q] = 1 - smoothstep(thr - 0.15, thr + 0.15, L[q] / 255);
  blur(height, w, h, smooth * 0.5 + 0.5);
  const map = new Uint8ClampedArray(w * h);
  for (let i = 0, q = 0; q < L.length; q++, i += 4) {
    paint(d, i, fg, bg, 1 - height[q]);
    map[q] = height[q] * 255;
  }
  relief(sub, map, { relief: 45, lightDirection: p.lightDirection, rect: { x: r.x - g.x, y: r.y - g.y, width: r.width, height: r.height } });
  ws.done();
  return img;
}

function reticulation(img, p, rect) {
  const density = clampNum(num(p.density, 12), 0, 50), fgLevel = clampNum(num(p.foregroundLevel, 40), 0, 50), bgLevel = clampNum(num(p.backgroundLevel, 5), 0, 50);
  const seed = num(p.seed, 1) | 0;
  const r = region(img, rect);
  if (isEmptyRegion(r)) return img;
  const W = img.width, d = img.data;
  const [fg, bg] = colorsOf(p);
  // the emulsion clumps into grains: a smooth noise sets the clump pattern (finer with density),
  // white noise roughens it; shadows clump into foreground, highlights stay background
  const cell = Math.max(1, 3 - density * 0.04);
  const n = smoothNoise(r.width, r.height, cell, seed, r.x, r.y);
  const wn = whiteNoise(r.width, r.height, seed + 1, r.x, r.y);
  for (let y = 0; y < r.height; y++) {
    for (let x = 0; x < r.width; x++) {
      const q = y * r.width + x, i = ((y + r.y) * W + x + r.x) * 4;
      const v = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 255000;
      const dark = (1 - v) * (fgLevel / 50) * 1.3 + 0.1, light = v * (bgLevel / 50);
      const prob = dark - light;
      const grain = clamp01(0.5 + (n[q] - 0.5) * 1.6 + (wn[q] - 0.5) * 0.4);
      paint(d, i, fg, bg, grain < prob ? 0 : 1);
    }
  }
  return img;
}

function stamp(img, p, rect) {
  const balance = clampNum(num(p.lightDarkBalance, 25), 0, 50), smooth = clampNum(num(p.smoothness, 5), 1, 50);
  const ws = workspace(img, rect, smooth * 1.5 + 2);
  if (!ws) return img;
  const { sub } = ws, w = sub.width, h = sub.height, d = sub.data;
  const L = blur(luma(sub), w, h, smooth * 0.5);
  const [fg, bg] = colorsOf(p);
  const thr = (balance / 50) * 255;
  for (let i = 0, q = 0; q < L.length; q++, i += 4) paint(d, i, fg, bg, L[q] < thr ? 0 : 1);
  ws.done();
  return img;
}

function tornEdges(img, p, rect) {
  const balance = clampNum(num(p.imageBalance, 25), 0, 50), smooth = clampNum(num(p.smoothness, 11), 1, 15), contrast = clampNum(num(p.contrast, 17), 1, 25);
  const seed = num(p.seed, 1) | 0;
  const ws = workspace(img, rect, smooth * 1.5 + 4);
  if (!ws) return img;
  const { sub, g } = ws, w = sub.width, h = sub.height, d = sub.data;
  // the tear: the tone is smoothed (smoothness widens the ramp at every edge) and smooth noise
  // shifts the threshold, so the paper edge wanders by several px; contrast sets how sharp it is
  const L = blur(luma(sub), w, h, 1 + smooth * 0.4);
  const n = smoothNoise(w, h, smooth * 0.5 + 2, seed, g.x, g.y);
  const fine = whiteNoise(w, h, seed + 3, g.x, g.y);
  const [fg, bg] = colorsOf(p);
  const thr = balance / 50, soft = 0.5 / contrast;
  for (let i = 0, q = 0; q < L.length; q++, i += 4) {
    const e = L[q] / 255 - thr + (n[q] - 0.5) * 0.4 + (fine[q] - 0.5) * 0.06;
    paint(d, i, fg, bg, smoothstep(-soft, soft, e));
  }
  ws.done();
  return img;
}

function waterPaper(img, p, rect) {
  const fibre = clampNum(num(p.fiberLength, 15), 3, 50), brightness = clampNum(num(p.brightness, 60), 0, 100), contrast = clampNum(num(p.contrast, 80), 0, 100);
  const ws = workspace(img, rect, fibre + 2);
  if (!ws) return img;
  const { sub, g } = ws, w = sub.width, h = sub.height, d = sub.data;
  // the paint bleeds along the vertical fibres: a premultiplied vertical box smear, two passes
  const half = Math.max(1, Math.round(fibre / 2));
  const n = w * h;
  const acc = new Float32Array(n * 4), tmp = new Float32Array(n * 4);
  for (let i = 0, q = 0; q < n; q++, i += 4) {
    const a = d[i + 3] / 255;
    acc[i] = d[i] * a;
    acc[i + 1] = d[i + 1] * a;
    acc[i + 2] = d[i + 2] * a;
    acc[i + 3] = a;
  }
  for (let pass = 0; pass < 2; pass++) {
    const src = pass ? tmp : acc, dst = pass ? acc : tmp;
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < 4; c++) {
        let sum = 0;
        for (let k = -half; k <= half; k++) sum += src[((k < 0 ? 0 : k >= h ? h - 1 : k) * w + x) * 4 + c];
        for (let y = 0; y < h; y++) {
          dst[(y * w + x) * 4 + c] = sum / (2 * half + 1);
          sum += src[((y + half + 1 >= h ? h - 1 : y + half + 1) * w + x) * 4 + c] - src[((y - half <= 0 ? 0 : y - half) * w + x) * 4 + c];
        }
      }
    }
  }
  // fibre texture: streaks of noise running down the sheet
  const streak = smoothNoise(w, h, 2, 17, g.x, g.y);
  const along = Float32Array.from(streak);
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let k = -8; k <= 8; k++) sum += streak[(k < 0 ? 0 : k >= h ? h - 1 : k) * w + x];
    for (let y = 0; y < h; y++) {
      along[y * w + x] = sum / 17;
      sum += streak[(y + 9 >= h ? h - 1 : y + 9) * w + x] - streak[(y - 8 <= 0 ? 0 : y - 8) * w + x];
    }
  }
  const gain = contrast <= 50 ? 0.4 + (contrast / 50) * 0.6 : 1 + ((contrast - 50) / 50) * 1.2;
  const offset = ((brightness - 50) / 50) * 70;
  for (let i = 0, q = 0; q < n; q++, i += 4) {
    const a = acc[i + 3];
    if (a <= 0) continue;
    const tex = 1 + (along[q] - 0.5) * 0.5;
    for (let c = 0; c < 3; c++) {
      const v = (acc[i + c] / a) * tex;
      d[i + c] = clampNum(128 + (v - 128) * gain + offset, 0, 255);
    }
  }
  ws.done();
  return img;
}

// ---------------------------------------------------------------------------------------------
// Texture

function craquelure(img, p, rect) {
  const spacing = clampNum(num(p.crackSpacing, 15), 2, 100), depth = clampNum(num(p.crackDepth, 6), 0, 10), bright = clampNum(num(p.crackBrightness, 9), 0, 10);
  const seed = num(p.seed, 1) | 0;
  const r = region(img, rect);
  if (isEmptyRegion(r)) return img;
  const W = img.width, d = img.data;
  const { f1, f2, dirx, diry } = voronoi(r.width, r.height, spacing, 0.9, seed, r.x, r.y);
  // cracks run along the cell borders; their floor is lit by crackBrightness (0 dark, 10 light)
  // and the plaster next to a crack is bevelled: the side facing the top-left light brightens
  const width = 0.8 + spacing / 30, bevel = width * (1 + depth * 0.3);
  const floor = 0.3 + bright * 0.1;
  const bk = (depth / 10) * 0.5;
  for (let y = 0; y < r.height; y++) {
    for (let x = 0; x < r.width; x++) {
      const q = y * r.width + x, i = ((y + r.y) * W + x + r.x) * 4;
      const edge = (f2[q] - f1[q]) / 2; // distance to the crack centre line
      const crack = 1 - smoothstep(0, width, edge);
      const near = (1 - smoothstep(width, width + bevel, edge)) * (1 - crack);
      // the slope at the bevel faces away from the nearest seed: lit when that points up-left
      const shade = 1 + near * bk * (dirx[q] * 0.7071 + diry[q] * 0.7071);
      const k = shade * (1 - crack) + floor * crack;
      d[i] = clampNum(d[i] * k, 0, 255);
      d[i + 1] = clampNum(d[i + 1] * k, 0, 255);
      d[i + 2] = clampNum(d[i + 2] * k, 0, 255);
    }
  }
  return img;
}

function grain(img, p, rect) {
  const intensity = clampNum(num(p.intensity, 40), 0, 100), contrast = clampNum(num(p.contrast, 50), 0, 100);
  const type = GRAIN_TYPES.includes(p.grainType) ? p.grainType : 'regular';
  const seed = num(p.seed, 1) | 0;
  const r = region(img, rect);
  if (isEmptyRegion(r)) return img;
  const W = img.width, d = img.data, w = r.width, h = r.height;
  // the grain field (−1..1 per pixel, one value or one per channel) by type
  const amp = (intensity / 100) * 128;
  let mono = null, rgbN = null;
  const two = (s) => whiteNoise(w, h, s, r.x, r.y);
  switch (type) {
    case 'soft': {
      mono = whiteNoise(w, h, seed, r.x, r.y);
      for (let i = 0; i < mono.length; i++) mono[i] = (mono[i] - 0.5) * 2;
      blur(mono, w, h, 1);
      for (let i = 0; i < mono.length; i++) mono[i] *= 2.2;
      break;
    }
    case 'clumped': {
      const n = smoothNoise(w, h, 3, seed, r.x, r.y), f = whiteNoise(w, h, seed + 2, r.x, r.y);
      mono = new Float32Array(w * h);
      for (let i = 0; i < mono.length; i++) mono[i] = (n[i] - 0.5) * 3 + (f[i] - 0.5) * 0.6;
      break;
    }
    case 'enlarged': {
      mono = new Float32Array(w * h);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) mono[y * w + x] = (hash3((x + r.x) >> 1, (y + r.y) >> 1, seed) - 0.5) * 2;
      break;
    }
    case 'contrasty': {
      mono = whiteNoise(w, h, seed, r.x, r.y);
      for (let i = 0; i < mono.length; i++) mono[i] = mono[i] < 0.5 ? -1 : 1;
      break;
    }
    case 'sprinkles':
    case 'stippled': {
      // sparse dots: probability grows with intensity, each dot a full step up (sprinkles) or down (stippled)
      mono = whiteNoise(w, h, seed, r.x, r.y);
      const prob = 0.02 + (intensity / 100) * 0.3;
      for (let i = 0; i < mono.length; i++) mono[i] = mono[i] < prob ? (type === 'sprinkles' ? 1.6 : -1.6) : 0;
      break;
    }
    case 'horizontal':
    case 'vertical': {
      const n = whiteNoise(w, h, seed, r.x, r.y);
      mono = new Float32Array(w * h);
      const len = 6;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        let sum = 0, cnt = 0;
        for (let k = -len; k <= len; k++) {
          const xx = type === 'horizontal' ? x + k : x, yy = type === 'horizontal' ? y : y + k;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          sum += n[yy * w + xx];
          cnt++;
        }
        mono[y * w + x] = (sum / cnt - 0.5) * 2 * Math.sqrt(2 * len + 1);
      }
      break;
    }
    case 'speckle': {
      rgbN = [two(seed), two(seed + 1), two(seed + 2)];
      const prob = 0.03 + (intensity / 100) * 0.3;
      for (const ch of rgbN) for (let i = 0; i < ch.length; i++) ch[i] = ch[i] < prob ? 1.4 : ch[i] > 1 - prob ? -1.4 : 0;
      break;
    }
    default: {
      // regular: the sum of two uniforms is roughly Gaussian
      const a = whiteNoise(w, h, seed, r.x, r.y), b = whiteNoise(w, h, seed + 1, r.x, r.y);
      mono = new Float32Array(w * h);
      for (let i = 0; i < mono.length; i++) mono[i] = (a[i] + b[i] - 1) * 1.6;
    }
  }
  // contrast 50 leaves the tone alone; lower flattens towards mid grey, higher stretches
  const gain = contrast <= 50 ? 0.3 + (contrast / 50) * 0.7 : 1 + ((contrast - 50) / 50) * 1.5;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const q = y * w + x, i = ((y + r.y) * W + x + r.x) * 4;
      for (let c = 0; c < 3; c++) {
        const nz = (mono ? mono[q] : rgbN[c][q]) * amp;
        d[i + c] = clampNum(128 + (d[i + c] - 128) * gain + nz, 0, 255);
      }
    }
  }
  return img;
}

function mosaicTiles(img, p, rect) {
  const tile = clampNum(num(p.tileSize, 12), 2, 100), groutW = clampNum(num(p.groutWidth, 3), 1, 15), lighten = clampNum(num(p.lightenGrout, 9), 0, 10);
  const seed = num(p.seed, 1) | 0;
  const r = region(img, rect);
  if (isEmptyRegion(r)) return img;
  const W = img.width, d = img.data;
  const { f1, f2, dirx, diry } = voronoi(r.width, r.height, tile + groutW, 0.35, seed, r.x, r.y);
  // irregular chips keep the image; the grout between them is a flat grey lightened by lightenGrout,
  // and each chip is bevelled towards the grout (lit from the top left)
  const groutLevel = 60 + lighten * 17;
  for (let y = 0; y < r.height; y++) {
    for (let x = 0; x < r.width; x++) {
      const q = y * r.width + x, i = ((y + r.y) * W + x + r.x) * 4;
      const edge = (f2[q] - f1[q]) / 2;
      const groutT = 1 - smoothstep(groutW / 2 - 0.5, groutW / 2 + 0.5, edge);
      const bevel = (1 - smoothstep(groutW / 2, groutW / 2 + 1.5, edge)) * (1 - groutT);
      const shade = 1 + bevel * 0.22 * (dirx[q] * 0.7071 + diry[q] * 0.7071);
      for (let c = 0; c < 3; c++) {
        const v = d[i + c] * shade;
        d[i + c] = clampNum(v + (groutLevel - v) * groutT, 0, 255);
      }
    }
  }
  return img;
}

function patchwork(img, p, rect) {
  const size = clampNum(num(p.squareSize, 4), 0, 10), reliefAmt = clampNum(num(p.relief, 8), 0, 25);
  const cell = Math.max(2, Math.round(2 + size * 1.5));
  const r = region(img, rect);
  if (isEmptyRegion(r)) return img;
  const W = img.width, H = img.height, d = img.data;
  // cell means over the whole-image grid touched by rect (alpha weighted), plus their luminance
  // one cell beyond rect on every side, so border shading against a neighbour matches a whole-image run
  const cx0 = Math.max(0, Math.floor(r.x / cell) - 1), cy0 = Math.max(0, Math.floor(r.y / cell) - 1);
  const cx1 = Math.min(Math.floor((W - 1) / cell), Math.floor((r.x + r.width - 1) / cell) + 1), cy1 = Math.min(Math.floor((H - 1) / cell), Math.floor((r.y + r.height - 1) / cell) + 1);
  const gw = cx1 - cx0 + 1, gh = cy1 - cy0 + 1;
  const sum = new Float64Array(gw * gh * 4);
  for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) {
    const o = ((cy - cy0) * gw + (cx - cx0)) * 4;
    const x0 = cx * cell, y0 = cy * cell, x1 = Math.min(W, x0 + cell), y1 = Math.min(H, y0 + cell);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const i = (y * W + x) * 4, a = d[i + 3] / 255;
      sum[o] += d[i] * a;
      sum[o + 1] += d[i + 1] * a;
      sum[o + 2] += d[i + 2] * a;
      sum[o + 3] += a;
    }
  }
  const mean = new Float32Array(gw * gh * 3), height = new Float32Array(gw * gh);
  for (let c = 0; c < gw * gh; c++) {
    const a = sum[c * 4 + 3];
    if (a > 0) for (let k = 0; k < 3; k++) mean[c * 3 + k] = sum[c * 4 + k] / a;
    height[c] = (mean[c * 3] * 299 + mean[c * 3 + 1] * 587 + mean[c * 3 + 2] * 114) / 255000;
  }
  // each square is a tile raised by its brightness, lit from the top left: its left/top border is
  // lit when it stands above that neighbour (and shaded below a higher one), its right/bottom
  // border is shaded wherever there is a step (its own wall turned away, or the neighbour's shadow)
  const k = (reliefAmt / 25) * 0.9;
  const hAt = (cx, cy) => height[Math.min(gh - 1, Math.max(0, cy - cy0)) * gw + Math.min(gw - 1, Math.max(0, cx - cx0))];
  const bw = cell >= 8 ? 2 : 1;
  for (let y = r.y; y < r.y + r.height; y++) {
    const cy = Math.floor(y / cell), ly = y - cy * cell;
    for (let x = r.x; x < r.x + r.width; x++) {
      const cx = Math.floor(x / cell), lx = x - cx * cell;
      const c = (cy - cy0) * gw + (cx - cx0);
      const h0 = height[c];
      let shade = 1;
      if (k > 0) {
        if (lx < bw && cx > 0) shade += k * (h0 - hAt(cx - 1, cy));
        if (lx >= cell - bw && (cx + 1) * cell < W) shade -= k * Math.abs(h0 - hAt(cx + 1, cy));
        if (ly < bw && cy > 0) shade += k * (h0 - hAt(cx, cy - 1));
        if (ly >= cell - bw && (cy + 1) * cell < H) shade -= k * Math.abs(h0 - hAt(cx, cy + 1));
      }
      const i = (y * W + x) * 4;
      d[i] = clampNum(mean[c * 3] * shade, 0, 255);
      d[i + 1] = clampNum(mean[c * 3 + 1] * shade, 0, 255);
      d[i + 2] = clampNum(mean[c * 3 + 2] * shade, 0, 255);
    }
  }
  return img;
}

function stainedGlass(img, p, rect) {
  const cellSize = clampNum(num(p.cellSize, 10), 2, 50), thickness = clampNum(num(p.borderThickness, 4), 1, 20), light = clampNum(num(p.lightIntensity, 3), 0, 10);
  const seed = num(p.seed, 1) | 0;
  const cell = cellSize * 2;
  const ws = workspace(img, rect, cell * 2);
  if (!ws) return img;
  const { sub, g, r } = ws, w = sub.width, h = sub.height, d = sub.data;
  const { f1, f2, id } = voronoi(w, h, cell, 0.8, seed, g.x, g.y);
  // every cell takes its alpha-weighted mean colour, leading (border colour) separates the cells,
  // light from behind the glass brightens towards the image centre
  const sums = new Map();
  for (let i = 0, q = 0; q < id.length; q++, i += 4) {
    let s = sums.get(id[q]);
    if (!s) sums.set(id[q], (s = new Float64Array(4)));
    const a = d[i + 3] / 255;
    s[0] += d[i] * a;
    s[1] += d[i + 1] * a;
    s[2] += d[i + 2] * a;
    s[3] += a;
  }
  const border = rgb(p.borderColor ?? (Array.isArray(p.colors) ? p.colors[0] : '#000000'), [0, 0, 0]);
  const W = img.width, H = img.height, cx = W / 2, cy = H / 2, maxD = Math.hypot(cx, cy) || 1;
  const x0 = r.x - g.x, y0 = r.y - g.y;
  for (let y = y0; y < y0 + r.height; y++) {
    for (let x = x0; x < x0 + r.width; x++) {
      const q = y * w + x, i = q * 4;
      if (f2[q] - f1[q] < thickness) {
        d[i] = border[0];
        d[i + 1] = border[1];
        d[i + 2] = border[2];
        continue;
      }
      const s = sums.get(id[q]);
      const dn = Math.hypot(x + g.x + 0.5 - cx, y + g.y + 0.5 - cy) / maxD;
      const glow = 1 + (light / 10) * (0.9 - 1.2 * dn);
      if (s && s[3] > 0) {
        d[i] = clampNum((s[0] / s[3]) * glow, 0, 255);
        d[i + 1] = clampNum((s[1] / s[3]) * glow, 0, 255);
        d[i + 2] = clampNum((s[2] / s[3]) * glow, 0, 255);
      }
    }
  }
  ws.done();
  return img;
}

function texturizer(img, p, rect) {
  const r = region(img, rect);
  if (isEmptyRegion(r)) return img;
  const map = textureFor({ ...p, texture: SURFACE_TEXTURES.includes(p.texture) ? p.texture : 'canvas' }, img, { x: 0, y: 0, width: img.width, height: img.height });
  return relief(img, map, { relief: clampNum(num(p.relief, 4), 0, 50), lightDirection: p.lightDirection, invert: !!p.invert, rect: r });
}

// ---------------------------------------------------------------------------------------------
// Distort (gallery only)

function diffuseGlow(img, p, rect) {
  const grainAmt = clampNum(num(p.graininess, 6), 0, 10), glowAmount = clampNum(num(p.glowAmount, 10), 0, 20), clear = clampNum(num(p.clearAmount, 15), 0, 20);
  const seed = num(p.seed, 1) | 0;
  const spread = 2 + glowAmount * 0.6;
  const ws = workspace(img, rect, spread * 3 + 2);
  if (!ws) return img;
  const { sub, g } = ws, w = sub.width, h = sub.height, d = sub.data;
  const L = luma(sub);
  // the highlights above the clear level glow: their mask spreads (a blur) and pulls the pixel
  // towards the glow colour, grain speckles the glow
  const thr = clear / 20;
  const mask = new Float32Array(L.length);
  for (let q = 0; q < L.length; q++) mask[q] = smoothstep(thr * 0.8, Math.min(1, thr + 0.15), L[q] / 255);
  blur(mask, w, h, spread);
  const glow = rgb(p.glowColor ?? '#ffffff', [255, 255, 255]);
  const n = whiteNoise(w, h, seed, g.x, g.y);
  const gk = glowAmount / 20;
  for (let i = 0, q = 0; q < L.length; q++, i += 4) {
    const m = clamp01(mask[q] * (1 + gk) * gk * 1.3);
    if (m <= 0) continue;
    const gr = (n[q] - 0.5) * (grainAmt / 10) * 90 * m;
    d[i] = clampNum(d[i] + (glow[0] - d[i]) * m + gr, 0, 255);
    d[i + 1] = clampNum(d[i + 1] + (glow[1] - d[i + 1]) * m + gr, 0, 255);
    d[i + 2] = clampNum(d[i + 2] + (glow[2] - d[i + 2]) * m + gr, 0, 255);
  }
  ws.done();
  return img;
}

/** Resamples img inside r from `src` (a copy covering g) at (x + dx, y + dy) per pixel; dx/dy come from a callback. */
function displaceBy(img, src, g, r, offset) {
  const W = img.width, d = img.data, out = [0, 0, 0, 0], v = [0, 0];
  for (let y = r.y; y < r.y + r.height; y++) {
    for (let x = r.x; x < r.x + r.width; x++) {
      offset(x, y, v);
      // sample the source copy; outside the copy (beyond the margin) clamp to its edge
      const sx = clampNum(x + v[0] - g.x, 0, g.width - 1), sy = clampNum(y + v[1] - g.y, 0, g.height - 1);
      sampleBilinear(src, sx, sy, out);
      const i = (y * W + x) * 4;
      d[i] = out[0];
      d[i + 1] = out[1];
      d[i + 2] = out[2];
      d[i + 3] = out[3];
    }
  }
}

function glass(img, p, rect) {
  const distortion = clampNum(num(p.distortion, 5), 0, 20), smooth = clampNum(num(p.smoothness, 3), 1, 15);
  const seed = num(p.seed, 1) | 0;
  const r = region(img, rect);
  if (isEmptyRegion(r)) return img;
  const margin = GLASS_PX_PER_UNIT * distortion + 2;
  const g = grow(img, r, margin);
  const src = cropImage(img, g);
  const W = img.width, H = img.height;
  const map = smoothHeight(textureFor({ ...p, texture: GLASS_TEXTURES.includes(p.texture) ? p.texture : 'frosted' }, img, { x: 0, y: 0, width: W, height: H }, seed), W, H, (smooth - 1) * 0.7);
  // refraction: the view shifts along the glass slope; the slope is at most 1/2 per px (0..255
  // over two pixels), so 6 px per unit of slope keeps the shift within GLASS_PX_PER_UNIT·distortion
  const k = distortion * 6 * (p.invert ? -1 : 1);
  displaceBy(img, src, g, r, (x, y, v) => {
    const xl = x > 0 ? x - 1 : 0, xr = x < W - 1 ? x + 1 : W - 1, yu = y > 0 ? y - 1 : 0, yd = y < H - 1 ? y + 1 : H - 1;
    v[0] = ((map[y * W + xr] - map[y * W + xl]) / 510) * k;
    v[1] = ((map[yd * W + x] - map[yu * W + x]) / 510) * k;
  });
  // a faint sheen off the glass surface
  relief(img, map, { relief: 5, lightDirection: 'top-left', invert: !!p.invert, rect: r });
  return img;
}

function oceanRipple(img, p, rect) {
  const size = clampNum(num(p.rippleSize, 9), 1, 15), magnitude = clampNum(num(p.rippleMagnitude, 9), 0, 20);
  const seed = num(p.seed, 1) | 0;
  if (magnitude <= 0) return img;
  const r = region(img, rect);
  if (isEmptyRegion(r)) return img;
  const margin = RIPPLE_PX_PER_UNIT * magnitude + 2;
  const g = grow(img, r, margin);
  const src = cropImage(img, g);
  // two independent fractal noise fields (one per axis), cells scaled by the ripple size
  const cell = 4 * size;
  const nx = fractalNoise(r.width, r.height, cell, seed, r.x, r.y, 3), ny = fractalNoise(r.width, r.height, cell, seed + 1000, r.x, r.y, 3);
  const k = RIPPLE_PX_PER_UNIT * magnitude * 2; // noise is 0..1 around 0.5: (n − 0.5)·2 spans −1..1
  displaceBy(img, src, g, r, (x, y, v) => {
    const q = (y - r.y) * r.width + (x - r.x);
    v[0] = (nx[q] - 0.5) * k;
    v[1] = (ny[q] - 0.5) * k;
  });
  return img;
}

// ---------------------------------------------------------------------------------------------
// Dialog fields (lib/form.js specs) and the table

const S = (key, label, min, max, step = 1, extra = {}) => ({ key, label, type: 'slider', min, max, step, ...extra });
const SEED = { key: 'seed', label: 'Seed', type: 'number', min: 0, max: 99999 };
const LIGHT = { key: 'lightDirection', label: 'Light', type: 'select', options: LIGHT_DIRECTIONS.map((d) => [d, d.split('-').map((s) => s[0].toUpperCase() + s.slice(1)).join(' ')]) };
const INVERT = { key: 'invert', label: 'Invert', type: 'checkbox' };
const SCALING = S('scaling', 'Scaling', 50, 200, 1, { unit: '%' });
const titleCase = (s) => s.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
const TEXTURE_FIELD = (names) => ({ key: 'texture', label: 'Texture', type: 'select', options: names.map((n) => [n, titleCase(n)]) });

const SK = (name, defaults, fn, fields, margin) => defineFilter(name, 'gallery', { ...defaults, colors: COLORS }, fn, { gallery: 'Sketch', fields, margin, ui: 'custom' });
const TX = (name, defaults, fn, fields, margin, extra = {}) => defineFilter(name, 'gallery', defaults, fn, { gallery: 'Texture', fields, margin, ...extra });
const DS = (name, defaults, fn, fields, margin, extra = {}) => defineFilter(name, 'gallery', defaults, fn, { gallery: 'Distort', fields, margin, ...extra });

export const GALLERY_SKETCH = Object.freeze({
  'bas-relief': SK('Bas Relief', { detail: 13, smoothness: 3, lightDirection: 'bottom' }, basRelief,
    [S('detail', 'Detail', 1, 15), S('smoothness', 'Smoothness', 1, 15), LIGHT], (p) => clampNum(num(p.smoothness, 3), 1, 15) * 2 + 2),
  'chalk-charcoal': SK('Chalk & Charcoal', { charcoalArea: 6, chalkArea: 6, strokePressure: 1, seed: 1 }, chalkCharcoal,
    [S('charcoalArea', 'Charcoal area', 0, 20), S('chalkArea', 'Chalk area', 0, 20), S('strokePressure', 'Stroke pressure', 0, 5), SEED], 12),
  charcoal: SK('Charcoal', { charcoalThickness: 1, detail: 5, lightDarkBalance: 50 }, charcoal,
    [S('charcoalThickness', 'Charcoal thickness', 1, 7), S('detail', 'Detail', 0, 5), S('lightDarkBalance', 'Light/Dark balance', 0, 100)], (p) => clampNum(num(p.charcoalThickness, 1), 1, 7) * 3 + 8),
  // Chrome ignores the colours (grey output) but keeps params.colors so the gallery can treat every Sketch kind alike
  chrome: defineFilter('Chrome', 'gallery', { detail: 4, smoothness: 7, colors: COLORS }, chrome,
    { gallery: 'Sketch', fields: [S('detail', 'Detail', 0, 10), S('smoothness', 'Smoothness', 0, 10)], margin: (p) => clampNum(num(p.smoothness, 7), 0, 10) * 2 + 4 }),
  'conte-crayon': SK('Conté Crayon', { foregroundLevel: 11, backgroundLevel: 7, texture: 'sandstone', scaling: 100, relief: 4, lightDirection: 'top', invert: false, textureImage: null }, conteCrayon,
    [S('foregroundLevel', 'Foreground level', 1, 15), S('backgroundLevel', 'Background level', 1, 15), TEXTURE_FIELD(SURFACE_TEXTURES), SCALING, S('relief', 'Relief', 0, 50), LIGHT, INVERT], 3),
  'graphic-pen': SK('Graphic Pen', { strokeLength: 15, lightDarkBalance: 50, strokeDirection: 'right-diagonal', seed: 1 }, graphicPen,
    [S('strokeLength', 'Stroke length', 1, 15), S('lightDarkBalance', 'Light/Dark balance', 0, 100), { key: 'strokeDirection', label: 'Stroke direction', type: 'select', options: STROKE_DIRECTIONS.map((d) => [d, titleCase(d)]) }, SEED], (p) => clampNum(num(p.strokeLength, 15), 1, 15) * 1.5 + 2),
  'halftone-pattern': SK('Halftone Pattern', { size: 1, contrast: 5, patternType: 'dot' }, halftonePattern,
    [S('size', 'Size', 1, 12), S('contrast', 'Contrast', 0, 50), { key: 'patternType', label: 'Pattern type', type: 'select', options: PATTERN_TYPES.map((d) => [d, titleCase(d)]) }], 0),
  'note-paper': SK('Note Paper', { imageBalance: 25, graininess: 10, relief: 11, seed: 1 }, notePaper,
    [S('imageBalance', 'Image balance', 0, 50), S('graininess', 'Graininess', 0, 20), S('relief', 'Relief', 0, 25), SEED], 6),
  photocopy: SK('Photocopy', { detail: 7, darkness: 8 }, photocopy,
    [S('detail', 'Detail', 1, 24), S('darkness', 'Darkness', 1, 50)], (p) => (3 + 24 - clampNum(num(p.detail, 7), 1, 24)) * 3 + 2),
  plaster: SK('Plaster', { imageBalance: 20, smoothness: 2, lightDirection: 'top' }, plaster,
    [S('imageBalance', 'Image balance', 0, 50), S('smoothness', 'Smoothness', 1, 15), LIGHT], (p) => clampNum(num(p.smoothness, 2), 1, 15) * 3 + 4),
  reticulation: SK('Reticulation', { density: 12, foregroundLevel: 40, backgroundLevel: 5, seed: 1 }, reticulation,
    [S('density', 'Density', 0, 50), S('foregroundLevel', 'Foreground level', 0, 50), S('backgroundLevel', 'Background level', 0, 50), SEED], 0),
  stamp: SK('Stamp', { lightDarkBalance: 25, smoothness: 5 }, stamp,
    [S('lightDarkBalance', 'Light/Dark balance', 0, 50), S('smoothness', 'Smoothness', 1, 50)], (p) => clampNum(num(p.smoothness, 5), 1, 50) * 1.5 + 2),
  'torn-edges': SK('Torn Edges', { imageBalance: 25, smoothness: 11, contrast: 17, seed: 1 }, tornEdges,
    [S('imageBalance', 'Image balance', 0, 50), S('smoothness', 'Smoothness', 1, 15), S('contrast', 'Contrast', 1, 25), SEED], (p) => clampNum(num(p.smoothness, 11), 1, 15) * 1.5 + 4),
  // Water Paper keeps the image's colours (params.colors is accepted and ignored)
  'water-paper': defineFilter('Water Paper', 'gallery', { fiberLength: 15, brightness: 60, contrast: 80, colors: COLORS }, waterPaper,
    { gallery: 'Sketch', fields: [S('fiberLength', 'Fiber length', 3, 50), S('brightness', 'Brightness', 0, 100), S('contrast', 'Contrast', 0, 100)], margin: (p) => clampNum(num(p.fiberLength, 15), 3, 50) + 2 }),
  craquelure: TX('Craquelure', { crackSpacing: 15, crackDepth: 6, crackBrightness: 9, seed: 1 }, craquelure,
    [S('crackSpacing', 'Crack spacing', 2, 100), S('crackDepth', 'Crack depth', 0, 10), S('crackBrightness', 'Crack brightness', 0, 10), SEED], 0),
  grain: TX('Grain', { intensity: 40, contrast: 50, grainType: 'regular', seed: 1 }, grain,
    [S('intensity', 'Intensity', 0, 100), S('contrast', 'Contrast', 0, 100), { key: 'grainType', label: 'Grain type', type: 'select', options: GRAIN_TYPES.map((d) => [d, titleCase(d)]) }, SEED], 0),
  'mosaic-tiles': TX('Mosaic Tiles', { tileSize: 12, groutWidth: 3, lightenGrout: 9, seed: 1 }, mosaicTiles,
    [S('tileSize', 'Tile size', 2, 100), S('groutWidth', 'Grout width', 1, 15), S('lightenGrout', 'Lighten grout', 0, 10), SEED], 0),
  patchwork: TX('Patchwork', { squareSize: 4, relief: 8 }, patchwork,
    [S('squareSize', 'Square size', 0, 10), S('relief', 'Relief', 0, 25)], 0),
  'stained-glass': TX('Stained Glass', { cellSize: 10, borderThickness: 4, lightIntensity: 3, seed: 1, borderColor: '#000000' }, stainedGlass,
    [S('cellSize', 'Cell size', 2, 50), S('borderThickness', 'Border thickness', 1, 20), S('lightIntensity', 'Light intensity', 0, 10), SEED], (p) => clampNum(num(p.cellSize, 10), 2, 50) * 4, { ui: 'custom' }),
  // textureImage (an ImageDataLike loaded from a file by lib/gallery-b-ui.js) replaces the procedural texture
  texturizer: TX('Texturizer', { texture: 'canvas', scaling: 100, relief: 4, lightDirection: 'top', invert: false, textureImage: null }, texturizer,
    [TEXTURE_FIELD(SURFACE_TEXTURES), SCALING, S('relief', 'Relief', 0, 50), LIGHT, INVERT], 1, { ui: 'custom' }),
  'diffuse-glow': DS('Diffuse Glow', { graininess: 6, glowAmount: 10, clearAmount: 15, glowColor: '#ffffff', seed: 1 }, diffuseGlow,
    [S('graininess', 'Graininess', 0, 10), S('glowAmount', 'Glow amount', 0, 20), S('clearAmount', 'Clear amount', 0, 20), { key: 'glowColor', label: 'Glow color', type: 'color' }, SEED], (p) => (2 + clampNum(num(p.glowAmount, 10), 0, 20) * 0.6) * 3 + 2),
  glass: DS('Glass', { distortion: 5, smoothness: 3, texture: 'frosted', scaling: 100, invert: false, seed: 1, textureImage: null }, glass,
    [S('distortion', 'Distortion', 0, 20), S('smoothness', 'Smoothness', 1, 15), TEXTURE_FIELD(GLASS_TEXTURES), SCALING, INVERT, SEED], (p) => GLASS_PX_PER_UNIT * clampNum(num(p.distortion, 5), 0, 20) + 2, { ui: 'custom' }),
  'ocean-ripple': DS('Ocean Ripple', { rippleSize: 9, rippleMagnitude: 9, seed: 1 }, oceanRipple,
    [S('rippleSize', 'Ripple size', 1, 15), S('rippleMagnitude', 'Ripple magnitude', 0, 20), SEED], (p) => RIPPLE_PX_PER_UNIT * clampNum(num(p.rippleMagnitude, 9), 0, 20) + 2),
});

export const SKETCH_KINDS = Object.freeze(Object.keys(GALLERY_SKETCH).filter((k) => GALLERY_SKETCH[k].gallery === 'Sketch'));
export const TEXTURE_KINDS = Object.freeze(Object.keys(GALLERY_SKETCH).filter((k) => GALLERY_SKETCH[k].gallery === 'Texture'));
export const DISTORT_KINDS = Object.freeze(Object.keys(GALLERY_SKETCH).filter((k) => GALLERY_SKETCH[k].gallery === 'Distort'));
/** Kinds whose dialog injects the current foreground/background colours (every Sketch kind that paints with them, plus Stained Glass's leading). */
export const COLOR_KINDS = Object.freeze([...SKETCH_KINDS.filter((k) => k !== 'chrome' && k !== 'water-paper'), 'stained-glass']);
/** Kinds with a texture picker that can load a texture file ("Load Texture…"). */
export const TEXTURE_FILE_KINDS = Object.freeze(['texturizer', 'conte-crayon', 'glass']);
