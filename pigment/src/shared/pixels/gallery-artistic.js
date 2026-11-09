// Filter Gallery kinds, part A (builder "gallery-a"): the Artistic and Brush Strokes groups and the
// 'filter-gallery' composite kind (a stack of gallery effects). These kinds have category 'gallery'
// (they are not in the Filter menu's top-level groups unless the "show all Filter Gallery groups"
// preference is on) and a `gallery` group name for the Filter Gallery dialog (lib/filter-gallery.js).
// Photoshop's gallery filters work on opaque 8-bit colour; here alpha is kept as it is and
// transparent pixels never bleed colour (every averaging pass is alpha weighted).
//
// Every effect takes Photoshop's parameters (names and ranges in `fields`) and reproduces the
// recognisable look from a small private toolkit: edge planes (Sobel of the premultiplied luma),
// separable plane blurs, local min/max, oriented strokes (the registry's motion blur), paper noise
// and the shared texture relief (textures.js). The conventions at the top of filters.js hold: rect
// limits writes only (the effect runs on the rect grown by the kind's margin and the rect part is
// written back, so a partial repaint matches a whole-image run within the margin's rounding), noise
// depends only on (seed, x, y), typed arrays and plain loops.

import { clampRect, inflateRect, cropImage, luminance, sampleBilinear } from './core.js';
import { parseColor } from './color.js';
import { num, clampNum, round8, smoothstep, defineFilter, region, isEmptyRegion } from './filter-def.js';
import { FILTERS } from './filters.js'; // used inside apply() only (call-time safe cycle)
import { texture, relief, TEXTURE_NAMES } from './textures.js';

/** @typedef {import('./core.js').ImageDataLike} ImageDataLike */

// ---------------------------------------------------------------------------------------------
// Toolkit (module private)

const grow = (img, r, px) => clampRect(inflateRect(r, Math.ceil(px)), img.width, img.height);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const int = (v, fallback, lo, hi) => Math.round(clampNum(num(v, fallback), lo, hi));
const flt = (v, fallback, lo, hi) => clampNum(num(v, fallback), lo, hi);

/**
 * Runs fn(sub, ox, oy) on a copy of rect grown by `margin` and writes the rect part back into img.
 * (ox, oy) is the copy's origin in the image, so noise and textures stay position stable. Alpha is
 * kept as it was unless `moves` is set (the kinds whose point is to displace pixels: spatter, strokes),
 * so the blurs inside an effect never soften a layer's transparency.
 */
function withRegion(img, rect, margin, fn, moves = false) {
  const r = region(img, rect);
  if (isEmptyRegion(r)) return img;
  const g = grow(img, r, margin);
  const sub = cropImage(img, g);
  fn(sub, g.x, g.y);
  const row = r.width * 4, W = img.width, d = img.data, sd = sub.data;
  for (let y = r.y; y < r.y + r.height; y++) {
    const s = ((y - g.y) * sub.width + (r.x - g.x)) * 4, t = (y * W + r.x) * 4;
    if (moves) d.set(sd.subarray(s, s + row), t);
    else for (let i = 0; i < row; i += 4) {
      d[t + i] = sd[s + i];
      d[t + i + 1] = sd[s + i + 1];
      d[t + i + 2] = sd[s + i + 2];
    }
  }
  return img;
}

/** Integer hash of three int32s (position-stable noise). */
function hash3(x, y, z) {
  let h = (Math.imul(x | 0, 0x27d4eb2d) + Math.imul(y | 0, 0x165667b1) + Math.imul(z | 0, 0x9e3779b1)) | 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}
const U32 = 4294967296;
/** Uniform 0..1 noise at an integer position. */
const noise01 = (x, y, seed) => hash3(x, y, seed) / U32;

/** Smooth value noise (lattice of `cell` px, Hermite interpolation), 0..1, position stable. */
function valueNoise(x, y, cell, seed) {
  const fx = x / cell, fy = y / cell;
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const tx = smoothstep(0, 1, fx - x0), ty = smoothstep(0, 1, fy - y0);
  const a = noise01(x0, y0, seed), b = noise01(x0 + 1, y0, seed), c = noise01(x0, y0 + 1, seed), d = noise01(x0 + 1, y0 + 1, seed);
  return (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
}

/** Premultiplied luma plane (0..255) of img: transparent pixels read as black so alpha edges are edges. */
function lumaPlane(img) {
  const d = img.data, L = new Float32Array(img.width * img.height);
  for (let i = 0, p = 0; p < L.length; p++, i += 4) L[p] = (luminance(d[i], d[i + 1], d[i + 2]) * d[i + 3]) / 255;
  return L;
}

/** Box radii of the three passes approximating a Gaussian of sigma (Kovesi). */
function boxRadii(sigma) {
  const n = 3;
  const ideal = Math.sqrt((12 * sigma * sigma) / n + 1);
  let wl = Math.floor(ideal);
  if (wl % 2 === 0) wl--;
  const wu = wl + 2;
  const m = Math.round((12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4));
  return [0, 1, 2].map((i) => ((i < m ? wl : wu) - 1) / 2);
}

/** One box pass of radius rad along x (dst) then y (src again), running sums, edges replicated. */
function boxPass(src, dst, w, h, rad) {
  if (rad <= 0) {
    dst.set(src);
    return;
  }
  const n = 2 * rad + 1;
  // horizontal into dst
  for (let y = 0; y < h; y++) {
    const o = y * w;
    let sum = 0;
    for (let k = -rad; k <= rad; k++) sum += src[o + (k < 0 ? 0 : k >= w ? w - 1 : k)];
    for (let x = 0; x < w; x++) {
      dst[o + x] = sum / n;
      const xa = x + rad + 1, xr = x - rad;
      sum += src[o + (xa >= w ? w - 1 : xa)] - src[o + (xr < 0 ? 0 : xr)];
    }
  }
  // vertical back into src (used as scratch), then swap
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let k = -rad; k <= rad; k++) sum += dst[(k < 0 ? 0 : k >= h ? h - 1 : k) * w + x];
    for (let y = 0; y < h; y++) {
      src[y * w + x] = sum / n;
      const ya = y + rad + 1, yr = y - rad;
      sum += dst[(ya >= h ? h - 1 : ya) * w + x] - dst[(yr < 0 ? 0 : yr) * w + x];
    }
  }
  dst.set(src);
}

/** Gaussian blur of a plane (three box passes), returns a new plane. */
function blurPlane(plane, w, h, sigma) {
  const out = new Float32Array(plane);
  if (!(sigma > 0.3)) return out;
  const scratch = new Float32Array(plane.length);
  for (const r of boxRadii(sigma)) boxPass(out, scratch, w, h, r);
  return out;
}

/** Sobel gradient magnitude of a plane (edges replicated), scaled so a hard 0 -> 255 step gives 255. */
function sobelPlane(L, w, h) {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const r0 = (y > 0 ? y - 1 : 0) * w, r1 = y * w, r2 = (y < h - 1 ? y + 1 : y) * w;
    for (let x = 0; x < w; x++) {
      const xm = x > 0 ? x - 1 : 0, xp = x < w - 1 ? x + 1 : x;
      const gx = L[r0 + xp] + 2 * L[r1 + xp] + L[r2 + xp] - (L[r0 + xm] + 2 * L[r1 + xm] + L[r2 + xm]);
      const gy = L[r2 + xm] + 2 * L[r2 + x] + L[r2 + xp] - (L[r0 + xm] + 2 * L[r0 + x] + L[r0 + xp]);
      out[r1 + x] = Math.sqrt(gx * gx + gy * gy) * 0.25;
    }
  }
  return out;
}

/** Separable square-window min (isMax false) or max of a plane, radius rad, returns a new plane. */
function minMaxPlane(plane, w, h, rad, isMax) {
  if (rad <= 0) return new Float32Array(plane);
  const tmp = new Float32Array(plane.length), out = new Float32Array(plane.length);
  for (let y = 0; y < h; y++) {
    const o = y * w;
    for (let x = 0; x < w; x++) {
      let v = plane[o + x];
      const x0 = Math.max(0, x - rad), x1 = Math.min(w - 1, x + rad);
      for (let k = x0; k <= x1; k++) {
        const s = plane[o + k];
        if (isMax ? s > v : s < v) v = s;
      }
      tmp[o + x] = v;
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let v = tmp[y * w + x];
      const y0 = Math.max(0, y - rad), y1 = Math.min(h - 1, y + rad);
      for (let k = y0; k <= y1; k++) {
        const s = tmp[k * w + x];
        if (isMax ? s > v : s < v) v = s;
      }
      out[y * w + x] = v;
    }
  }
  return out;
}

/** Registry passes on a sub-image (alpha weighted, edges replicated, O(pixels)). */
const gaussianRGBA = (img, sigma) => (sigma > 0.05 ? FILTERS['gaussian-blur'].apply(img, { radius: sigma }) : img);
const motionRGBA = (img, angle, distance) => (distance >= 1 ? FILTERS['motion-blur'].apply(img, { angle, distance }) : img);
const medianRGBA = (img, radius) => (radius >= 1 ? FILTERS.median.apply(img, { radius }) : img);
const oilRGBA = (img, radius, levels) => FILTERS['oil-paint'].apply(img, { radius: Math.max(1, radius), levels: clampNum(Math.round(levels), 2, 256) });
const unsharpRGBA = (img, amount, radius = 1) => (amount > 0 ? FILTERS['unsharp-mask'].apply(img, { amount, radius, threshold: 0 }) : img);
const copyOf = (img) => ({ width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) });

/** Smears a plane along `angle` over `distance` px (as an opaque grey image through the motion blur). */
function motionPlane(plane, w, h, angle, distance) {
  const img = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
  const d = img.data;
  for (let p = 0, i = 0; p < plane.length; p++, i += 4) {
    const v = round8(plane[p]);
    d[i] = d[i + 1] = d[i + 2] = v;
    d[i + 3] = 255;
  }
  motionRGBA(img, angle, distance);
  const out = new Float32Array(plane.length);
  for (let p = 0, i = 0; p < out.length; p++, i += 4) out[p] = d[i];
  return out;
}

/** Posterizes the RGB channels to `levels` evenly spaced values (alpha kept). */
function posterizeRGB(img, levels) {
  const n = clampNum(Math.round(levels), 2, 255);
  const lut = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) lut[v] = Math.round((Math.floor((v * n) / 256) * 255) / (n - 1));
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    d[i] = lut[d[i]];
    d[i + 1] = lut[d[i + 1]];
    d[i + 2] = lut[d[i + 2]];
  }
  return img;
}

/**
 * Cut-paper quantization: the luma snaps to one of `levels` evenly spaced values and the colour differences
 * (chroma) to coarse steps, so tones go flat but hues stay where they were (a per-channel posterize would shift
 * a blue sky towards purple). Grey pixels end up on exactly `levels` values; alpha is kept.
 */
function posterizeLuma(img, levels) {
  const n = clampNum(Math.round(levels), 2, 255), step = 24;
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const L = luminance(d[i], d[i + 1], d[i + 2]);
    const Lq = (Math.floor((L * n) / 256) * 255) / (n - 1);
    d[i] = round8(Lq + Math.round((d[i] - L) / step) * step);
    d[i + 1] = round8(Lq + Math.round((d[i + 1] - L) / step) * step);
    d[i + 2] = round8(Lq + Math.round((d[i + 2] - L) / step) * step);
  }
  return img;
}

/** [r, g, b] 0..255 of a colour param ('#rrggbb', rgb(), ...), with a fallback. */
function rgbOf(v, fallback) {
  try {
    const c = parseColor(v ?? fallback);
    if (c && Number.isFinite(c[0])) return [c[0], c[1], c[2]];
  } catch {
    /* fall through */
  }
  return parseColor(fallback);
}

/**
 * Height map (0..255, one byte per sub pixel) for the texture params of a kind: the procedural texture
 * of the whole image cropped to the sub region (position stable), or params.textureImage (an
 * ImageDataLike loaded from a file) tiled at `scaling` %.
 */
function heightMapFor(p, sub, ox, oy, fullW, fullH, seed = 1) {
  const w = sub.width, h = sub.height;
  const out = new Uint8ClampedArray(w * h);
  const ti = p.textureImage;
  if (ti && ti.width > 0 && ti.height > 0 && ti.data && ti.data.length >= ti.width * ti.height * 4) {
    const s = clampNum(num(p.scaling, 100), 50, 200) / 100;
    for (let y = 0; y < h; y++) {
      const ty = Math.floor((((y + oy) / s) % ti.height + ti.height) % ti.height);
      for (let x = 0; x < w; x++) {
        const tx = Math.floor((((x + ox) / s) % ti.width + ti.width) % ti.width);
        const i = (ty * ti.width + tx) * 4;
        out[y * w + x] = round8(luminance(ti.data[i], ti.data[i + 1], ti.data[i + 2]));
      }
    }
    return out;
  }
  const name = TEXTURE_NAMES.includes(p.texture) ? p.texture : 'canvas';
  const full = texture(name, fullW, fullH, { scaling: clampNum(num(p.scaling, 100), 50, 200), seed });
  if (ox === 0 && oy === 0 && w === fullW && h === fullH) return full;
  for (let y = 0; y < h; y++) out.set(full.subarray((y + oy) * fullW + ox, (y + oy) * fullW + ox + w), y * w);
  return out;
}

/** Lights sub by its texture (textures.js relief) with the kind's relief params, blended by `weight` 0..1. */
function applyRelief(p, sub, ox, oy, fullW, fullH, weight = 1) {
  const amount = clampNum(num(p.relief, 4), 0, 50);
  if (amount <= 0 || weight <= 0) return sub;
  const height = heightMapFor(p, sub, ox, oy, fullW, fullH);
  if (weight >= 1) return relief(sub, height, { relief: amount, lightDirection: p.lightDirection, invert: !!p.invert });
  const lit = relief(copyOf(sub), height, { relief: amount, lightDirection: p.lightDirection, invert: !!p.invert });
  const d = sub.data, l = lit.data;
  for (let i = 0; i < d.length; i += 4) {
    d[i] = round8(d[i] + (l[i] - d[i]) * weight);
    d[i + 1] = round8(d[i + 1] + (l[i + 1] - d[i + 1]) * weight);
    d[i + 2] = round8(d[i + 2] + (l[i + 2] - d[i + 2]) * weight);
  }
  return sub;
}

/** Multiplies RGB by a per-pixel factor plane (alpha kept). */
function scaleRGB(img, factor) {
  const d = img.data;
  for (let p = 0, i = 0; p < factor.length; p++, i += 4) {
    const k = factor[p];
    if (k === 1) continue;
    d[i] = round8(d[i] * k);
    d[i + 1] = round8(d[i + 1] * k);
    d[i + 2] = round8(d[i + 2] * k);
  }
  return img;
}

/** Mottles RGB with smooth noise: factor 1 + amp * (noise - 0.5) * 2, cell px, position stable. */
function mottle(img, ox, oy, amp, cell, seed) {
  if (amp <= 0) return img;
  const w = img.width, h = img.height, d = img.data;
  for (let y = 0, i = 0; y < h; y++) {
    for (let x = 0; x < w; x++, i += 4) {
      const k = 1 + amp * (valueNoise(x + ox, y + oy, cell, seed) - 0.5) * 2;
      d[i] = round8(d[i] * k);
      d[i + 1] = round8(d[i + 1] * k);
      d[i + 2] = round8(d[i + 2] * k);
    }
  }
  return img;
}

// ---------------------------------------------------------------------------------------------
// Artistic

function coloredPencil(img, p, rect) {
  const width = flt(p.pencilWidth, 4, 1, 24), pressure = flt(p.strokePressure, 8, 0, 15) / 15, bright = flt(p.paperBrightness, 25, 0, 50);
  // the paper is the background colour at the requested brightness (25 of 50 = Photoshop's mid grey on white)
  const bg = rgbOf(p.colors?.[1], '#ffffff');
  const paper = bg.map((c) => round8((c * bright) / 50));
  return withRegion(img, rect, width + 3, (sub, ox, oy) => {
    const w = sub.width, h = sub.height, d = sub.data;
    const L = lumaPlane(sub);
    const edge = sobelPlane(blurPlane(L, w, h, 0.4 + width / 6), w, h);
    // hatching runs along the anti-diagonal in stripes `width` px apart, so flat dark areas read as pencil strokes
    const stripe = Math.max(2, Math.round(width * 1.5));
    const dark = 0.55 + 0.45 * (1 - pressure);
    for (let y = 0, p4 = 0, i = 0; y < h; y++) {
      for (let x = 0; x < w; x++, p4++, i += 4) {
        const X = x + ox, Y = y + oy;
        const hatch = valueNoise(Math.floor((X + Y) / 2), Math.floor((X - Y) / stripe), 1, 17);
        const cover = clamp01((edge[p4] / 255) * (2 + 3 * pressure) + (1 - L[p4] / 255) * (0.3 + pressure) * hatch * (d[i + 3] / 255));
        for (let c = 0; c < 3; c++) d[i + c] = round8(paper[c] + (d[i + c] * dark - paper[c]) * cover);
      }
    }
  });
}

function cutout(img, p, rect) {
  const levels = int(p.levels, 4, 2, 8), simplicity = int(p.edgeSimplicity, 4, 0, 10), fidelity = int(p.edgeFidelity, 2, 1, 3);
  const sigma = simplicity * 0.6, medianR = Math.round((simplicity * (4 - fidelity)) / 3);
  return withRegion(img, rect, sigma * 3 + medianR + 2, (sub) => {
    gaussianRGBA(sub, sigma);
    posterizeLuma(sub, levels);
    // the median keeps the quantized values (it picks one of the window's), so the level count stays at `levels`
    medianRGBA(sub, medianR);
  });
}

function dryBrush(img, p, rect) {
  const size = flt(p.brushSize, 2, 0, 10), detail = flt(p.brushDetail, 8, 0, 10), tex = flt(p.texture, 1, 1, 3);
  const radius = 1 + Math.round(size * 0.6);
  return withRegion(img, rect, radius + 3, (sub, ox, oy) => {
    oilRGBA(sub, radius, 4 + detail * 3);
    mottle(sub, ox, oy, 0.05 * tex, 3, 31);
  });
}

function filmGrain(img, p, rect) {
  const grain = flt(p.grain, 4, 0, 20), area = flt(p.highlightArea, 0, 0, 20), intensity = flt(p.intensity, 10, 0, 10), seed = num(p.seed, 1) | 0;
  const sigma = grain * 2.5, thr = 255 - area * 8;
  return withRegion(img, rect, 0, (sub, ox, oy) => {
    const w = sub.width, h = sub.height, d = sub.data;
    for (let y = 0, i = 0; y < h; y++) {
      for (let x = 0; x < w; x++, i += 4) {
        if (d[i + 3] === 0) continue;
        const X = x + ox, Y = y + oy;
        // sum of three uniforms: close enough to Gaussian grain, mono (film grain is luminance noise)
        const n = (noise01(X, Y, seed) + noise01(X, Y, seed + 101) + noise01(X, Y, seed + 202) - 1.5) * 2 * sigma;
        let r = d[i] + n, g = d[i + 1] + n, b = d[i + 2] + n;
        if (area > 0) {
          const L = luminance(d[i], d[i + 1], d[i + 2]);
          if (L > thr) {
            const t = ((L - thr) / (255 - thr)) * (intensity / 10) * 0.6;
            r += (255 - r) * t;
            g += (255 - g) * t;
            b += (255 - b) * t;
          }
        }
        d[i] = round8(r);
        d[i + 1] = round8(g);
        d[i + 2] = round8(b);
      }
    }
  });
}

function fresco(img, p, rect) {
  const size = flt(p.brushSize, 2, 0, 10), detail = flt(p.brushDetail, 8, 0, 10), tex = flt(p.texture, 1, 1, 3);
  const radius = 2 + Math.round(size);
  return withRegion(img, rect, radius + 3, (sub, ox, oy) => {
    oilRGBA(sub, radius, 3 + detail);
    // fresco pigment sinks into the plaster: darks go darker, with coarse mottling
    const d = sub.data;
    for (let i = 0; i < d.length; i += 4) {
      const L = luminance(d[i], d[i + 1], d[i + 2]) / 255;
      const k = 0.72 + 0.28 * L;
      d[i] = round8(d[i] * k);
      d[i + 1] = round8(d[i + 1] * k);
      d[i + 2] = round8(d[i + 2] * k);
    }
    mottle(sub, ox, oy, 0.06 * tex, 2, 37);
  });
}

function neonGlow(img, p, rect) {
  const size = flt(p.glowSize, 5, -24, 24), bright = flt(p.glowBrightness, 15, 0, 50) / 50;
  const fg = rgbOf(p.colors?.[0], '#000000'), bg = rgbOf(p.colors?.[1], '#ffffff'), glow = rgbOf(p.glowColor, '#0000ff');
  const centre = 0.5 + (size / 24) * 0.4, width = 0.22;
  return withRegion(img, rect, 3, (sub) => {
    const w = sub.width, h = sub.height, d = sub.data;
    const L = blurPlane(lumaPlane(sub), w, h, 1);
    for (let p4 = 0, i = 0; p4 < L.length; p4++, i += 4) {
      if (d[i + 3] === 0) continue;
      const g = L[p4] / 255 / (d[i + 3] / 255);
      const t = (g - centre) / width;
      const wgt = bright * Math.exp(-t * t);
      for (let c = 0; c < 3; c++) {
        const base = fg[c] + (bg[c] - fg[c]) * g;
        d[i + c] = round8(base + (glow[c] - base) * wgt);
      }
    }
  });
}

const DAUB_TYPES = ['simple', 'light-rough', 'dark-rough', 'wide-sharp', 'wide-blurry', 'sparkle'];

function paintDaubs(img, p, rect) {
  const size = flt(p.brushSize, 8, 1, 50), sharp = flt(p.sharpness, 7, 0, 40), type = DAUB_TYPES.includes(p.brushType) ? p.brushType : 'simple';
  const wide = type === 'wide-sharp' || type === 'wide-blurry';
  const radius = Math.max(1, Math.round((size / 2) * (wide ? 1.5 : 1)));
  return withRegion(img, rect, radius + 4, (sub, ox, oy) => {
    const w = sub.width, h = sub.height, d = sub.data;
    oilRGBA(sub, radius, 24);
    if (type === 'wide-blurry') gaussianRGBA(sub, radius * 0.5);
    if (type === 'light-rough' || type === 'dark-rough') {
      const sign = type === 'light-rough' ? 1 : -1;
      for (let y = 0, i = 0; y < h; y++) {
        for (let x = 0; x < w; x++, i += 4) {
          const n = sign * (noise01(x + ox, y + oy, 53) - 0.3) * 40;
          if (n * sign <= 0) continue;
          d[i] = round8(d[i] + n);
          d[i + 1] = round8(d[i + 1] + n);
          d[i + 2] = round8(d[i + 2] + n);
        }
      }
    }
    if (type === 'sparkle') {
      for (let y = 0, i = 0; y < h; y++) {
        for (let x = 0; x < w; x++, i += 4) {
          if (d[i + 3] === 0 || noise01(x + ox, y + oy, 59) < 0.985) continue;
          d[i] = round8(d[i] + 90);
          d[i + 1] = round8(d[i + 1] + 90);
          d[i + 2] = round8(d[i + 2] + 90);
        }
      }
    }
    unsharpRGBA(sub, sharp * (type === 'wide-sharp' ? 8 : 5), 1);
  });
}

function paletteKnife(img, p, rect) {
  const size = flt(p.strokeSize, 25, 1, 50), detail = int(p.strokeDetail, 3, 1, 3), soft = flt(p.softness, 0, 0, 10);
  const radius = Math.max(1, Math.round(size / 5)), sigma = soft / 4;
  return withRegion(img, rect, radius + sigma * 3 + 2, (sub) => {
    oilRGBA(sub, radius, 4 + detail * 4);
    gaussianRGBA(sub, sigma);
  });
}

function plasticWrap(img, p, rect) {
  const strength = flt(p.highlightStrength, 15, 0, 20) / 20, detail = flt(p.detail, 9, 1, 15), smooth = flt(p.smoothness, 7, 1, 15);
  const sigma = smooth / 2, slope = 3 + detail * 0.8, shininess = 2 + detail * 2;
  // light from the top left; the specular term is measured against a flat surface so flat areas stay as they are
  const lx = -0.5, ly = -0.5, lz = 1.7, ln = Math.hypot(lx, ly, lz);
  const hx = lx / ln, hy = ly / ln, hz = lz / ln;
  const flat = Math.pow(hz, shininess);
  return withRegion(img, rect, sigma * 3 + 2, (sub) => {
    const w = sub.width, h = sub.height, d = sub.data;
    const Lb = blurPlane(lumaPlane(sub), w, h, sigma);
    for (let y = 0; y < h; y++) {
      const r0 = (y > 0 ? y - 1 : 0) * w, r1 = y * w, r2 = (y < h - 1 ? y + 1 : y) * w;
      for (let x = 0; x < w; x++) {
        const i = (r1 + x) * 4;
        if (d[i + 3] === 0) continue;
        const xm = x > 0 ? x - 1 : 0, xp = x < w - 1 ? x + 1 : x;
        const gx = ((Lb[r1 + xp] - Lb[r1 + xm]) / 510) * slope, gy = ((Lb[r2 + x] - Lb[r0 + x]) / 510) * slope;
        const nn = Math.hypot(gx, gy, 1);
        const ndoth = (-gx * hx - gy * hy + hz) / nn;
        const spec = ndoth > 0 ? Math.max(0, (Math.pow(ndoth, shininess) - flat) / (1 - flat)) : 0;
        if (spec <= 0) continue;
        const k = spec * strength * 1.3;
        d[i] = round8(d[i] + (255 - d[i]) * k);
        d[i + 1] = round8(d[i + 1] + (255 - d[i + 1]) * k);
        d[i + 2] = round8(d[i + 2] + (255 - d[i + 2]) * k);
      }
    }
  });
}

function posterEdges(img, p, rect) {
  const thick = flt(p.edgeThickness, 2, 0, 10), intensity = flt(p.edgeIntensity, 1, 0, 10), poster = int(p.posterization, 2, 0, 6);
  const dilate = Math.round(thick / 2);
  return withRegion(img, rect, dilate + 3, (sub) => {
    const w = sub.width, h = sub.height;
    let mag = sobelPlane(blurPlane(lumaPlane(sub), w, h, 0.6), w, h);
    if (dilate > 0) mag = minMaxPlane(mag, w, h, dilate, true);
    posterizeRGB(sub, poster + 2);
    const gain = 0.4 + (intensity / 10) * 1.6;
    const factor = new Float32Array(mag.length);
    for (let i = 0; i < mag.length; i++) factor[i] = 1 - clamp01((mag[i] / 255) * gain);
    scaleRGB(sub, factor);
  });
}

function roughPastels(img, p, rect) {
  const length = flt(p.strokeLength, 6, 0, 40), detail = flt(p.strokeDetail, 4, 1, 20);
  const fullW = img.width, fullH = img.height;
  return withRegion(img, rect, length + 2, (sub, ox, oy) => {
    if (length >= 1) {
      // diagonal pastel strokes; stroke detail is how much of the original shows through them
      const strokes = motionRGBA(copyOf(sub), 45, length);
      const keep = (detail / 20) * 0.8, d = sub.data, s = strokes.data;
      for (let i = 0; i < d.length; i += 4) {
        d[i] = round8(s[i] + (d[i] - s[i]) * keep);
        d[i + 1] = round8(s[i + 1] + (d[i + 1] - s[i + 1]) * keep);
        d[i + 2] = round8(s[i + 2] + (d[i + 2] - s[i + 2]) * keep);
      }
    }
    applyRelief(p, sub, ox, oy, fullW, fullH, 1);
  });
}

function smudgeStick(img, p, rect) {
  const length = flt(p.strokeLength, 2, 0, 10), area = flt(p.highlightArea, 0, 0, 20), intensity = flt(p.intensity, 10, 0, 10);
  const distance = 2 + length * 1.5, thr = 255 - area * 8;
  return withRegion(img, rect, distance + 2, (sub) => {
    // dark tones smear diagonally into their light neighbours (a darkening smear only)
    const smear = motionRGBA(copyOf(sub), 135, distance);
    const d = sub.data, s = smear.data;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] === 0) continue;
      const w = s[i + 3] / 255;
      for (let c = 0; c < 3; c++) {
        const v = d[i + c] + (Math.min(d[i + c], s[i + c]) - d[i + c]) * w;
        d[i + c] = round8(v);
      }
      if (area > 0) {
        const L = luminance(d[i], d[i + 1], d[i + 2]);
        if (L > thr) {
          const t = ((L - thr) / (255 - thr)) * (intensity / 10) * 0.6;
          for (let c = 0; c < 3; c++) d[i + c] = round8(d[i + c] + (255 - d[i + c]) * t);
        }
      }
    }
  });
}

function sponge(img, p, rect) {
  const size = flt(p.brushSize, 2, 0, 10), definition = flt(p.definition, 12, 0, 25), smooth = flt(p.smoothness, 5, 1, 15), seed = num(p.seed, 1) | 0;
  if (definition <= 0) return img;
  const cell = 3 + size * 1.2, edge = 0.05 + (1 - smooth / 15) * 0.3, amount = (definition / 25) * 0.55;
  return withRegion(img, rect, 0, (sub, ox, oy) => {
    const w = sub.width, h = sub.height, d = sub.data;
    for (let y = 0, i = 0; y < h; y++) {
      for (let x = 0; x < w; x++, i += 4) {
        const n = 0.65 * valueNoise(x + ox, y + oy, cell, seed) + 0.35 * valueNoise(x + ox, y + oy, cell / 2, seed + 7);
        const blob = smoothstep(0.5 - edge, 0.5 + edge, n);
        const k = 1 - amount * blob;
        d[i] = round8(d[i] * k);
        d[i + 1] = round8(d[i + 1] * k);
        d[i + 2] = round8(d[i + 2] * k);
      }
    }
  });
}

function underpainting(img, p, rect) {
  const size = flt(p.brushSize, 6, 0, 40), coverage = flt(p.textureCoverage, 16, 0, 40);
  const sigma = size / 8, fullW = img.width, fullH = img.height;
  return withRegion(img, rect, sigma * 3 + 2, (sub, ox, oy) => {
    gaussianRGBA(sub, sigma);
    applyRelief(p, sub, ox, oy, fullW, fullH, coverage / 40);
  });
}

function watercolor(img, p, rect) {
  const detail = flt(p.brushDetail, 9, 1, 14), shadow = flt(p.shadowIntensity, 1, 0, 10), tex = flt(p.texture, 1, 1, 3);
  const radius = Math.max(1, Math.round((15 - detail) / 3));
  return withRegion(img, rect, radius + 4, (sub, ox, oy) => {
    const w = sub.width, h = sub.height;
    medianRGBA(sub, radius);
    // pigment pools along the edges of each wash
    const mag = sobelPlane(blurPlane(lumaPlane(sub), w, h, 0.8), w, h);
    const factor = new Float32Array(mag.length);
    const gain = 0.3 + (shadow / 10) * 0.7;
    for (let i = 0; i < mag.length; i++) factor[i] = 1 - clamp01((mag[i] / 255) * gain);
    scaleRGB(sub, factor);
    mottle(sub, ox, oy, 0.03 * tex, 4, 41);
  });
}

// ---------------------------------------------------------------------------------------------
// Brush Strokes

function accentedEdges(img, p, rect) {
  const width = flt(p.edgeWidth, 2, 1, 14), bright = flt(p.edgeBrightness, 38, 0, 50) / 50, smooth = flt(p.smoothness, 5, 1, 15);
  const dilate = Math.round((width - 1) / 2), sigma = smooth / 4;
  // brightness below the middle paints the edges as ink, above as chalk; the middle leaves the image alone
  const toWhite = bright >= 0.5, weight = Math.abs(bright - 0.5) * 2;
  if (weight <= 0) return img;
  return withRegion(img, rect, dilate + sigma * 3 + 3, (sub) => {
    const w = sub.width, h = sub.height, d = sub.data;
    let mag = sobelPlane(blurPlane(lumaPlane(sub), w, h, sigma), w, h);
    if (dilate > 0) mag = minMaxPlane(mag, w, h, dilate, true);
    for (let p4 = 0, i = 0; p4 < mag.length; p4++, i += 4) {
      const k = clamp01((mag[p4] / 255) * 2) * weight;
      if (k <= 0) continue;
      for (let c = 0; c < 3; c++) d[i + c] = round8(d[i + c] + ((toWhite ? 255 : 0) - d[i + c]) * k);
    }
  });
}

function angledStrokes(img, p, rect) {
  const balance = flt(p.directionBalance, 50, 0, 100), length = flt(p.strokeLength, 15, 3, 50), sharp = flt(p.sharpness, 3, 0, 10);
  const T = 255 * (1 - balance / 100);
  return withRegion(img, rect, length + 2, (sub) => {
    const L = lumaPlane(sub);
    const a = motionRGBA(copyOf(sub), 45, length), b = motionRGBA(copyOf(sub), -45, length);
    const d = sub.data, da = a.data, db = b.data;
    for (let p4 = 0, i = 0; p4 < L.length; p4++, i += 4) {
      // light tones stroke one way, dark tones the other; the balance moves the split
      const wa = smoothstep(T - 32, T + 32, L[p4] / Math.max(1 / 255, d[i + 3] / 255));
      for (let c = 0; c < 4; c++) d[i + c] = round8(db[i + c] + (da[i + c] - db[i + c]) * wa);
    }
    unsharpRGBA(sub, sharp * 10, 1);
  }, true);
}

function crosshatch(img, p, rect) {
  const length = flt(p.strokeLength, 9, 3, 50), sharp = flt(p.sharpness, 6, 0, 20), strength = int(p.strength, 1, 1, 3);
  return withRegion(img, rect, length + 3, (sub) => {
    const w = sub.width, h = sub.height;
    const mag = sobelPlane(blurPlane(lumaPlane(sub), w, h, 0.6), w, h);
    const h1 = motionPlane(mag, w, h, 45, length), h2 = motionPlane(mag, w, h, -45, length);
    const factor = new Float32Array(mag.length);
    for (let i = 0; i < mag.length; i++) factor[i] = 1 - 0.85 * clamp01(((h1[i] + h2[i]) / 255) * strength * 1.2);
    scaleRGB(sub, factor);
    unsharpRGBA(sub, sharp * 5, 1);
  });
}

function darkStrokes(img, p, rect) {
  const balance = flt(p.balance, 5, 0, 10), black = flt(p.blackIntensity, 6, 0, 10) / 10, white = flt(p.whiteIntensity, 2, 0, 10) / 10;
  if (black <= 0 && white <= 0) return img;
  const T = 25.5 * balance;
  return withRegion(img, rect, 6, (sub) => {
    const L = lumaPlane(sub);
    const smear = motionRGBA(copyOf(sub), 45, 4);
    const d = sub.data, s = smear.data;
    for (let p4 = 0, i = 0; p4 < L.length; p4++, i += 4) {
      const a = d[i + 3];
      if (a === 0) continue;
      const l = L[p4] / (a / 255);
      if (l < T) {
        // short dark strokes: the smear only ever darkens, scaled by how deep in the shadows the pixel is
        const k = black * (1 - l / Math.max(1, T));
        for (let c = 0; c < 3; c++) {
          const dark = Math.min(d[i + c], s[i + c]) * (1 - 0.6 * k);
          d[i + c] = round8(d[i + c] + (dark - d[i + c]) * k);
        }
      } else {
        const k = white * ((l - T) / Math.max(1, 255 - T));
        for (let c = 0; c < 3; c++) {
          const light = Math.max(d[i + c], s[i + c]);
          d[i + c] = round8(d[i + c] + (light + (255 - light) * 0.6 - d[i + c]) * k);
        }
      }
    }
  });
}

function inkOutlines(img, p, rect) {
  const length = flt(p.strokeLength, 4, 1, 50), dark = flt(p.darkIntensity, 20, 0, 50) / 50, light = flt(p.lightIntensity, 10, 0, 50) / 50;
  return withRegion(img, rect, length + 3, (sub) => {
    const w = sub.width, h = sub.height, d = sub.data;
    let mag = sobelPlane(blurPlane(lumaPlane(sub), w, h, 0.5), w, h);
    mag = motionPlane(mag, w, h, 45, length);
    for (let p4 = 0, i = 0; p4 < mag.length; p4++, i += 4) {
      if (d[i + 3] === 0) continue;
      const ink = clamp01((mag[p4] / 255) * (0.6 + dark * 2.4));
      const k = 1 - ink * 0.9 * (0.3 + dark * 0.7);
      const lift = light * 0.4 * (1 - ink);
      for (let c = 0; c < 3; c++) {
        const v = d[i + c] * k;
        d[i + c] = round8(v + (255 - v) * lift);
      }
    }
  });
}

/**
 * Displaces every pixel by a random field of up to `radius` px (edges replicated), in place: a speckle
 * (per-pixel) field for low smoothness, a smooth (lattice) field for high smoothness, mixed in between.
 */
function spatterInto(sub, ox, oy, radius, smooth, seed) {
  if (radius <= 0) return sub;
  const w = sub.width, h = sub.height;
  const src = copyOf(sub), d = sub.data, out = [0, 0, 0, 0];
  const cell = 2 + smooth, mixS = clamp01((smooth - 1) / 14), amp = radius * 0.6;
  for (let y = 0, i = 0; y < h; y++) {
    for (let x = 0; x < w; x++, i += 4) {
      const X = x + ox, Y = y + oy;
      const nx = (1 - mixS) * noise01(X, Y, seed + 3) + mixS * valueNoise(X, Y, cell, seed);
      const ny = (1 - mixS) * noise01(X, Y, seed + 5) + mixS * valueNoise(X, Y, cell, seed + 1009);
      const dx = (nx - 0.5) * 2 * amp, dy = (ny - 0.5) * 2 * amp;
      const sx = Math.min(w - 1, Math.max(0, x + dx)), sy = Math.min(h - 1, Math.max(0, y + dy));
      sampleBilinear(src, sx, sy, out);
      d[i] = round8(out[0]);
      d[i + 1] = round8(out[1]);
      d[i + 2] = round8(out[2]);
      d[i + 3] = round8(out[3]);
    }
  }
  return sub;
}

function spatter(img, p, rect) {
  const radius = flt(p.sprayRadius, 10, 0, 25), smooth = flt(p.smoothness, 5, 1, 15), seed = num(p.seed, 1) | 0;
  if (radius <= 0) return img;
  return withRegion(img, rect, radius + 2, (sub, ox, oy) => spatterInto(sub, ox, oy, radius, smooth, seed), true);
}

const STROKE_ANGLES = { 'right-diagonal': 45, horizontal: 0, 'left-diagonal': -45, vertical: 90 };

function sprayedStrokes(img, p, rect) {
  const length = flt(p.strokeLength, 12, 0, 20), radius = flt(p.sprayRadius, 7, 0, 25), seed = num(p.seed, 1) | 0;
  const angle = STROKE_ANGLES[p.strokeDirection] ?? 45;
  return withRegion(img, rect, radius + length + 2, (sub, ox, oy) => {
    spatterInto(sub, ox, oy, radius, 4, seed);
    motionRGBA(sub, angle, length);
  }, true);
}

function sumiE(img, p, rect) {
  const width = flt(p.strokeWidth, 10, 3, 15), pressure = flt(p.strokePressure, 2, 0, 15) / 15, contrast = flt(p.contrast, 16, 0, 40) / 40;
  const radius = Math.max(1, Math.round(width / 4));
  return withRegion(img, rect, radius * 3 + 2, (sub) => {
    const w = sub.width, h = sub.height, d = sub.data;
    const L = lumaPlane(sub);
    // the ink bleeds: every pixel takes on the darkest luma nearby (softened), then the contrast of ink on rice paper
    const Lmin = blurPlane(minMaxPlane(L, w, h, radius, false), w, h, radius / 2);
    const gain = 1 + contrast * 1.2, bleed = 0.7 + pressure * 0.3;
    for (let p4 = 0, i = 0; p4 < L.length; p4++, i += 4) {
      if (d[i + 3] === 0) continue;
      const ratio = (Lmin[p4] + 1) / (L[p4] + 1);
      const k = 1 + (Math.min(1, ratio) - 1) * bleed;
      for (let c = 0; c < 3; c++) {
        const v = d[i + c] * k;
        d[i + c] = round8(128 + (v - 128) * gain - pressure * 20 * (1 - v / 255));
      }
    }
  });
}

// ---------------------------------------------------------------------------------------------
// Dialog fields (lib/form.js specs; keys are parameter paths) and the table

const S = (key, label, min, max, step = 1, extra = {}) => ({ key, label, type: 'slider', min, max, step, ...extra });
const SEED = { key: 'seed', label: 'Seed', type: 'number', min: 0, max: 99999 };
const TEXTURE_LABELS = { canvas: 'Canvas', brick: 'Brick', burlap: 'Burlap', sandstone: 'Sandstone', frosted: 'Frosted Glass', blocks: 'Blocks', 'tiny-lens': 'Tiny Lens' };
const LIGHT_DIRECTIONS = [['top', 'Top'], ['top-right', 'Top Right'], ['right', 'Right'], ['bottom-right', 'Bottom Right'], ['bottom', 'Bottom'], ['bottom-left', 'Bottom Left'], ['left', 'Left'], ['top-left', 'Top Left']];
/** Texture options shared by Rough Pastels and Underpainting (Texturizer and Conté Crayon use the same set). */
const TEXTURE_FIELDS = [
  { key: 'texture', label: 'Texture', type: 'select', options: TEXTURE_NAMES.map((n) => [n, TEXTURE_LABELS[n] ?? n]) },
  S('scaling', 'Scaling', 50, 200, 1, { unit: '%' }),
  S('relief', 'Relief', 0, 50, 1),
  { key: 'lightDirection', label: 'Light', type: 'select', options: LIGHT_DIRECTIONS },
  { key: 'invert', label: 'Invert', type: 'checkbox' },
];

const A = (name, defaults, fn, extra = {}) => defineFilter(name, 'gallery', defaults, fn, { gallery: 'Artistic', ...extra });
const B = (name, defaults, fn, extra = {}) => defineFilter(name, 'gallery', defaults, fn, { gallery: 'Brush Strokes', ...extra });

/**
 * The Artistic and Brush Strokes kinds plus the 'filter-gallery' composite. Parameters are Photoshop's
 * (ranges in `fields`); `margin` is what a kind reads around each pixel.
 */
export const GALLERY_ARTISTIC = Object.freeze({
  // Filter > Filter Gallery…: a stack of gallery effects applied in order (the dialog edits params.effects; each
  // entry { kind, params, enabled }). Category 'special' keeps it out of the group submenus; ui 'custom' means
  // lib/filter-gallery.js opens the gallery instead of a field dialog. Works for any implemented gallery kind.
  'filter-gallery': defineFilter('Filter Gallery', 'special', { effects: [] }, (img, p, rect) => {
    for (const e of Array.isArray(p.effects) ? p.effects : []) {
      const def = e && typeof e.kind === 'string' ? FILTERS[e.kind] : null;
      if (def && def.category === 'gallery' && !def.placeholder && e.enabled !== false) def.apply(img, e.params ?? {}, rect);
    }
    return img;
  }, { ui: 'custom', margin: 64 }),

  'colored-pencil': A('Colored Pencil', { pencilWidth: 4, strokePressure: 8, paperBrightness: 25 }, coloredPencil, {
    fields: [S('pencilWidth', 'Pencil width', 1, 24), S('strokePressure', 'Stroke pressure', 0, 15), S('paperBrightness', 'Paper brightness', 0, 50)],
    margin: (p) => clampNum(num(p.pencilWidth, 4), 1, 24) + 3,
  }),
  cutout: A('Cutout', { levels: 4, edgeSimplicity: 4, edgeFidelity: 2 }, cutout, {
    fields: [S('levels', 'Number of levels', 2, 8), S('edgeSimplicity', 'Edge simplicity', 0, 10), S('edgeFidelity', 'Edge fidelity', 1, 3)],
    margin: (p) => clampNum(num(p.edgeSimplicity, 4), 0, 10) * 3 + 10,
  }),
  'dry-brush': A('Dry Brush', { brushSize: 2, brushDetail: 8, texture: 1 }, dryBrush, {
    fields: [S('brushSize', 'Brush size', 0, 10), S('brushDetail', 'Brush detail', 0, 10), S('texture', 'Texture', 1, 3)],
    margin: (p) => clampNum(num(p.brushSize, 2), 0, 10) + 4,
  }),
  'film-grain': A('Film Grain', { grain: 4, highlightArea: 0, intensity: 10, seed: 1 }, filmGrain, {
    fields: [S('grain', 'Grain', 0, 20), S('highlightArea', 'Highlight area', 0, 20), S('intensity', 'Intensity', 0, 10), SEED],
    margin: 0,
  }),
  fresco: A('Fresco', { brushSize: 2, brushDetail: 8, texture: 1 }, fresco, {
    fields: [S('brushSize', 'Brush size', 0, 10), S('brushDetail', 'Brush detail', 0, 10), S('texture', 'Texture', 1, 3)],
    margin: (p) => clampNum(num(p.brushSize, 2), 0, 10) + 5,
  }),
  'neon-glow': A('Neon Glow', { glowSize: 5, glowBrightness: 15, glowColor: '#0000ff' }, neonGlow, {
    fields: [S('glowSize', 'Glow size', -24, 24), S('glowBrightness', 'Glow brightness', 0, 50), { key: 'glowColor', label: 'Glow color', type: 'color' }],
    margin: 3,
  }),
  'paint-daubs': A('Paint Daubs', { brushSize: 8, sharpness: 7, brushType: 'simple' }, paintDaubs, {
    fields: [S('brushSize', 'Brush size', 1, 50), S('sharpness', 'Sharpness', 0, 40), { key: 'brushType', label: 'Brush type', type: 'select', options: [['simple', 'Simple'], ['light-rough', 'Light Rough'], ['dark-rough', 'Dark Rough'], ['wide-sharp', 'Wide Sharp'], ['wide-blurry', 'Wide Blurry'], ['sparkle', 'Sparkle']] }],
    margin: (p) => clampNum(num(p.brushSize, 8), 1, 50) + 4,
  }),
  'palette-knife': A('Palette Knife', { strokeSize: 25, strokeDetail: 3, softness: 0 }, paletteKnife, {
    fields: [S('strokeSize', 'Stroke size', 1, 50), S('strokeDetail', 'Stroke detail', 1, 3), S('softness', 'Softness', 0, 10)],
    margin: (p) => clampNum(num(p.strokeSize, 25), 1, 50) / 5 + clampNum(num(p.softness, 0), 0, 10) + 3,
  }),
  'plastic-wrap': A('Plastic Wrap', { highlightStrength: 15, detail: 9, smoothness: 7 }, plasticWrap, {
    fields: [S('highlightStrength', 'Highlight strength', 0, 20), S('detail', 'Detail', 1, 15), S('smoothness', 'Smoothness', 1, 15)],
    margin: (p) => clampNum(num(p.smoothness, 7), 1, 15) * 1.5 + 3,
  }),
  'poster-edges': A('Poster Edges', { edgeThickness: 2, edgeIntensity: 1, posterization: 2 }, posterEdges, {
    fields: [S('edgeThickness', 'Edge thickness', 0, 10), S('edgeIntensity', 'Edge intensity', 0, 10), S('posterization', 'Posterization', 0, 6)],
    margin: (p) => clampNum(num(p.edgeThickness, 2), 0, 10) + 3,
  }),
  'rough-pastels': A('Rough Pastels', { strokeLength: 6, strokeDetail: 4, texture: 'canvas', scaling: 100, relief: 20, lightDirection: 'bottom', invert: false }, roughPastels, {
    fields: [S('strokeLength', 'Stroke length', 0, 40), S('strokeDetail', 'Stroke detail', 1, 20), ...TEXTURE_FIELDS],
    margin: (p) => clampNum(num(p.strokeLength, 6), 0, 40) + 2,
  }),
  'smudge-stick': A('Smudge Stick', { strokeLength: 2, highlightArea: 0, intensity: 10 }, smudgeStick, {
    fields: [S('strokeLength', 'Stroke length', 0, 10), S('highlightArea', 'Highlight area', 0, 20), S('intensity', 'Intensity', 0, 10)],
    margin: (p) => clampNum(num(p.strokeLength, 2), 0, 10) * 1.5 + 4,
  }),
  sponge: A('Sponge', { brushSize: 2, definition: 12, smoothness: 5, seed: 1 }, sponge, {
    fields: [S('brushSize', 'Brush size', 0, 10), S('definition', 'Definition', 0, 25), S('smoothness', 'Smoothness', 1, 15), SEED],
    margin: 0,
  }),
  underpainting: A('Underpainting', { brushSize: 6, textureCoverage: 16, texture: 'canvas', scaling: 100, relief: 4, lightDirection: 'top', invert: false }, underpainting, {
    fields: [S('brushSize', 'Brush size', 0, 40), S('textureCoverage', 'Texture coverage', 0, 40), ...TEXTURE_FIELDS],
    margin: (p) => clampNum(num(p.brushSize, 6), 0, 40) * 0.4 + 2,
  }),
  watercolor: A('Watercolor', { brushDetail: 9, shadowIntensity: 1, texture: 1 }, watercolor, {
    fields: [S('brushDetail', 'Brush detail', 1, 14), S('shadowIntensity', 'Shadow intensity', 0, 10), S('texture', 'Texture', 1, 3)],
    margin: 9,
  }),

  'accented-edges': B('Accented Edges', { edgeWidth: 2, edgeBrightness: 38, smoothness: 5 }, accentedEdges, {
    fields: [S('edgeWidth', 'Edge width', 1, 14), S('edgeBrightness', 'Edge brightness', 0, 50), S('smoothness', 'Smoothness', 1, 15)],
    margin: (p) => clampNum(num(p.edgeWidth, 2), 1, 14) + clampNum(num(p.smoothness, 5), 1, 15) + 3,
  }),
  'angled-strokes': B('Angled Strokes', { directionBalance: 50, strokeLength: 15, sharpness: 3 }, angledStrokes, {
    fields: [S('directionBalance', 'Direction balance', 0, 100), S('strokeLength', 'Stroke length', 3, 50), S('sharpness', 'Sharpness', 0, 10)],
    margin: (p) => clampNum(num(p.strokeLength, 15), 3, 50) + 2,
  }),
  crosshatch: B('Crosshatch', { strokeLength: 9, sharpness: 6, strength: 1 }, crosshatch, {
    fields: [S('strokeLength', 'Stroke length', 3, 50), S('sharpness', 'Sharpness', 0, 20), S('strength', 'Strength', 1, 3)],
    margin: (p) => clampNum(num(p.strokeLength, 9), 3, 50) + 3,
  }),
  'dark-strokes': B('Dark Strokes', { balance: 5, blackIntensity: 6, whiteIntensity: 2 }, darkStrokes, {
    fields: [S('balance', 'Balance', 0, 10), S('blackIntensity', 'Black intensity', 0, 10), S('whiteIntensity', 'White intensity', 0, 10)],
    margin: 6,
  }),
  'ink-outlines': B('Ink Outlines', { strokeLength: 4, darkIntensity: 20, lightIntensity: 10 }, inkOutlines, {
    fields: [S('strokeLength', 'Stroke length', 1, 50), S('darkIntensity', 'Dark intensity', 0, 50), S('lightIntensity', 'Light intensity', 0, 50)],
    margin: (p) => clampNum(num(p.strokeLength, 4), 1, 50) + 3,
  }),
  spatter: B('Spatter', { sprayRadius: 10, smoothness: 5, seed: 1 }, spatter, {
    fields: [S('sprayRadius', 'Spray radius', 0, 25), S('smoothness', 'Smoothness', 1, 15), SEED],
    margin: (p) => clampNum(num(p.sprayRadius, 10), 0, 25) + 2,
  }),
  'sprayed-strokes': B('Sprayed Strokes', { strokeLength: 12, sprayRadius: 7, strokeDirection: 'right-diagonal', seed: 1 }, sprayedStrokes, {
    fields: [S('strokeLength', 'Stroke length', 0, 20), S('sprayRadius', 'Spray radius', 0, 25), { key: 'strokeDirection', label: 'Stroke direction', type: 'select', options: [['right-diagonal', 'Right Diagonal'], ['horizontal', 'Horizontal'], ['left-diagonal', 'Left Diagonal'], ['vertical', 'Vertical']] }, SEED],
    margin: (p) => clampNum(num(p.strokeLength, 12), 0, 20) + clampNum(num(p.sprayRadius, 7), 0, 25) + 2,
  }),
  'sumi-e': B('Sumi-e', { strokeWidth: 10, strokePressure: 2, contrast: 16 }, sumiE, {
    fields: [S('strokeWidth', 'Stroke width', 3, 15), S('strokePressure', 'Stroke pressure', 0, 15), S('contrast', 'Contrast', 0, 40)],
    margin: (p) => clampNum(num(p.strokeWidth, 10), 3, 15) + 2,
  }),
});

/** The sample image the Filter Gallery renders its thumbnails from: a tiny landscape (sky, sun, hills, a house), 80x60, opaque. */
export function sampleImage(width = 80, height = 60) {
  const img = { width, height, data: new Uint8ClampedArray(width * height * 4) };
  const d = img.data;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const u = x / width, v = y / height;
      let r, g, b;
      const hill1 = 0.62 + 0.1 * Math.sin(u * 5.1) + 0.05 * Math.sin(u * 13 + 1), hill2 = 0.72 + 0.08 * Math.cos(u * 4.2 + 2);
      if (v < hill1) {
        // sky: blue gradient with a yellow sun
        r = 90 + 110 * v;
        g = 150 + 70 * v;
        b = 235;
        const dx = (u - 0.72) * width, dy = (v - 0.22) * height, rr = Math.hypot(dx, dy);
        if (rr < 7) {
          r = 255;
          g = 225;
          b = 90;
        }
      } else if (v < hill2) {
        r = 70 + 40 * (1 - v);
        g = 140 + 30 * Math.sin(u * 20);
        b = 60;
      } else {
        r = 50 + 30 * v;
        g = 110 - 30 * v;
        b = 40;
      }
      // a red house with a dark roof and a white door
      if (u > 0.2 && u < 0.4 && v > 0.55 && v < 0.75) {
        r = 190;
        g = 50;
        b = 40;
        if (u > 0.28 && u < 0.33 && v > 0.64) r = g = b = 240;
      }
      if (v > 0.45 && v <= 0.55 && Math.abs(u - 0.3) < (v - 0.45) * 1.2) {
        r = 70;
        g = 40;
        b = 30;
      }
      d[i] = round8(r);
      d[i + 1] = round8(g);
      d[i + 2] = round8(b);
      d[i + 3] = 255;
    }
  }
  return img;
}
