// Image > Apply Image and Calculations (builder "adjust-more"): blending one image's composite or
// a single channel into another, and blending two single channels into a grey result. Pure, no DOM.
//
// Both build on blend.js, so every layer blend mode is available; 'add' and 'subtract' are the
// arithmetic modes of Photoshop's dialogs: (target ± source) / scale + offset.

import { clampRect } from './core.js';
import { blendImages, separableLut, blendPixel, isBlendMode } from './blend.js';

/** @typedef {import('./core.js').ImageDataLike} ImageDataLike */
/** @typedef {import('./core.js').Rect} Rect */
/** @typedef {{ width: number, height: number, data: Uint8ClampedArray }} GreyPlane  data is w*h grey values or w*h*4 RGBA */

export const CHANNEL_IDS = Object.freeze(['rgb', 'r', 'g', 'b', 'a', 'gray', 'selection', 'mask']);
/** Arithmetic modes offered next to the blend modes. */
export const ARITHMETIC_MODES = Object.freeze(['add', 'subtract']);

const clampNum = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/**
 * One channel of an RGBA image as a grey plane (w*h): 'r' | 'g' | 'b', 'a' (transparency: the
 * alpha), 'gray' or 'rgb' (Rec. 601 luma), 'selection' | 'mask' (the image is the grey rendering
 * of that selection or mask: its red channel).
 * @param {ImageDataLike} img @param {string} channel @returns {Uint8ClampedArray}
 */
export function extractChannel(img, channel = 'gray') {
  const n = img.width * img.height, d = img.data;
  const out = new Uint8ClampedArray(n);
  const off = { r: 0, g: 1, b: 2, a: 3, selection: 0, mask: 0 }[channel];
  if (off !== undefined) {
    for (let p = 0, i = off; p < n; p++, i += 4) out[p] = d[i];
  } else {
    for (let p = 0, i = 0; p < n; p++, i += 4) out[p] = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2] + 0.5) | 0;
  }
  return out;
}

/** A grey plane (w*h values) from a GreyPlane whose data may be RGBA (luma) or already grey. */
function greyOf(plane) {
  const n = plane.width * plane.height;
  if (plane.data.length === n) return plane.data;
  if (plane.data.length === n * 4) return extractChannel(plane, 'gray');
  throw new RangeError('Channel data does not match its size');
}

/** 256x256 table of an arithmetic mode: t[(s << 8) | b] = (b ± s) / scale + offset, clamped. */
function arithmeticLut(mode, scale, offset) {
  const sc = clampNum(num(scale, 1), 1, 2), of = clampNum(num(offset, 0), -255, 255);
  const sign = mode === 'add' ? 1 : -1;
  const t = new Uint8ClampedArray(65536);
  for (let s = 0; s < 256; s++) for (let b = 0; b < 256; b++) t[(s << 8) | b] = Math.round((b + sign * s) / sc + of); // half up (the typed array alone would round half to even)
  return t;
}

const usesArithmetic = (o) => o.blend === 'add' || (o.blend === 'subtract' && (num(o.scale, 1) !== 1 || num(o.offset, 0) !== 0));

/**
 * Apply Image: blends `source` (same size as target) into `target` in place and returns target.
 *   channel   'rgb' uses the source colours; 'r' | 'g' | 'b' | 'a' | 'gray' use that channel as a grey
 *             image; 'selection' | 'mask' expect source to be the grey rendering of a selection or mask
 *   invert    inverts the source (colour or channel) first
 *   blend     any blend mode, or 'add' / 'subtract' with scale (1..2) and offset (-255..255):
 *             (target ± source) / scale + offset
 *   opacity   0..100
 *   preserveTransparency  the target's alpha is kept and transparent target pixels stay untouched
 *   mask      { data: Uint8ClampedArray(w*h), invert? }: the result is applied through it
 * With a blend mode, opacity 100 and no mask or flags this is exactly blendImages(mode, source, target).
 * A single-channel source is opaque everywhere (a channel has no transparency of its own).
 * @param {ImageDataLike} target @param {ImageDataLike} source @param {object} [options] @param {Rect | null} [rect]
 */
export function applyImage(target, source, options = {}, rect = null) {
  const o = { channel: 'rgb', invert: false, blend: 'multiply', opacity: 100, preserveTransparency: false, mask: null, scale: 1, offset: 0, ...options };
  const w = target.width, h = target.height;
  if (source.width !== w || source.height !== h) throw new RangeError('Apply Image needs a source of the same size as the target');
  const r = clampRect(rect, w, h);
  if (r.width <= 0 || r.height <= 0) return target;
  const arithmetic = usesArithmetic(o);
  if (!arithmetic && !isBlendMode(o.blend)) throw new RangeError(`Unknown blend mode: ${String(o.blend)}`);
  const opacity = clampNum(num(o.opacity, 100), 0, 100) / 100;
  if (opacity <= 0) return target;
  // the effective source image: channel picked, inverted
  let src = source;
  const single = o.channel && o.channel !== 'rgb';
  if (single || o.invert) {
    const sd = source.data, data = new Uint8ClampedArray(sd.length);
    if (single) {
      const grey = extractChannel(source, o.channel);
      for (let p = 0, i = 0; p < grey.length; p++, i += 4) {
        const v = o.invert ? 255 - grey[p] : grey[p];
        data[i] = data[i + 1] = data[i + 2] = v;
        data[i + 3] = 255;
      }
    } else {
      for (let i = 0; i < sd.length; i += 4) {
        data[i] = 255 - sd[i];
        data[i + 1] = 255 - sd[i + 1];
        data[i + 2] = 255 - sd[i + 2];
        data[i + 3] = sd[i + 3];
      }
    }
    src = { width: w, height: h, data };
  }
  const td = target.data;
  const mask = o.mask?.data && o.mask.data.length === w * h ? o.mask : null;
  const needOriginal = !!mask || !!o.preserveTransparency;
  const original = needOriginal ? new Uint8ClampedArray(td) : null;
  if (arithmetic) {
    const lut = arithmeticLut(o.blend, o.scale, o.offset);
    const sd = src.data;
    for (let y = r.y, ye = r.y + r.height; y < ye; y++) {
      let i = (y * w + r.x) * 4;
      for (let x = 0; x < r.width; x++, i += 4) {
        const sa = (sd[i + 3] / 255) * opacity;
        if (sa <= 0) continue;
        const da = td[i + 3] / 255;
        if (da <= 0) {
          // nothing to calculate with: the source shows through as in every blend mode
          td[i] = sd[i];
          td[i + 1] = sd[i + 1];
          td[i + 2] = sd[i + 2];
          td[i + 3] = sa * 255;
          continue;
        }
        const ao = sa + da * (1 - sa);
        for (let c = 0; c < 3; c++) {
          const s = sd[i + c], b = td[i + c];
          const blended = lut[(s << 8) | b];
          td[i + c] = (sa * (1 - da) * s + sa * da * blended + (1 - sa) * da * b) / ao;
        }
        td[i + 3] = ao * 255;
      }
    }
  } else blendImages(o.blend, src, target, opacity, r);
  if (needOriginal) {
    const md = mask?.data, inv = !!mask?.invert;
    for (let y = r.y, ye = r.y + r.height; y < ye; y++) {
      let p = y * w + r.x, i = p * 4;
      for (let x = 0; x < r.width; x++, p++, i += 4) {
        const oa = original[i + 3];
        if (o.preserveTransparency) {
          if (oa === 0) {
            td[i] = original[i];
            td[i + 1] = original[i + 1];
            td[i + 2] = original[i + 2];
            td[i + 3] = 0;
            continue;
          }
          td[i + 3] = oa;
        }
        if (md) {
          const t = (inv ? 255 - md[p] : md[p]) / 255;
          if (t >= 1) continue;
          if (t <= 0 || td[i + 3] === 0) {
            td[i] = original[i];
            td[i + 1] = original[i + 1];
            td[i + 2] = original[i + 2];
            td[i + 3] = oa;
            continue;
          }
          if (oa === 0) {
            td[i + 3] *= t; // colours of the result, coverage through the mask
            continue;
          }
          td[i] = original[i] + (td[i] - original[i]) * t;
          td[i + 1] = original[i + 1] + (td[i + 1] - original[i + 1]) * t;
          td[i + 2] = original[i + 2] + (td[i + 2] - original[i + 2]) * t;
          td[i + 3] = oa + (td[i + 3] - oa) * t;
        }
      }
    }
  }
  return target;
}

/**
 * Calculations: blends channel `a` (Source 1) onto channel `b` (Source 2) and returns the grey
 * result as a mask (Uint8ClampedArray w*h).
 *   blend     any blend mode (applied to grey values), or 'add' / 'subtract' with scale and offset:
 *             (b ± a) / scale + offset
 *   opacity   0..100, how much of the blended value replaces b
 *   invertA, invertB  invert a source first
 *   mask      { data: Uint8ClampedArray(w*h), invert? }: where it is black the result stays b
 * @param {GreyPlane} a @param {GreyPlane} b @param {object} [options] @returns {Uint8ClampedArray}
 */
export function calculations(a, b, options = {}) {
  const o = { blend: 'multiply', opacity: 100, invertA: false, invertB: false, mask: null, scale: 1, offset: 0, ...options };
  if (a.width !== b.width || a.height !== b.height) throw new RangeError('Calculations needs two sources of the same size');
  const n = a.width * a.height;
  const A = greyOf(a), B = greyOf(b);
  const arithmetic = usesArithmetic(o);
  if (!arithmetic && !isBlendMode(o.blend)) throw new RangeError(`Unknown blend mode: ${String(o.blend)}`);
  // every mode reduces to a 256x256 table on greys: separable modes directly, the others through blendPixel on (v, v, v)
  let lut = arithmetic ? arithmeticLut(o.blend, o.scale, o.offset) : separableLut(o.blend);
  if (!lut) {
    lut = new Uint8ClampedArray(65536);
    for (let s = 0; s < 256; s++) for (let v = 0; v < 256; v++) {
      const c = blendPixel(o.blend, s, s, s, v, v, v);
      lut[(s << 8) | v] = (0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2] + 0.5) | 0;
    }
  }
  const opacity = clampNum(num(o.opacity, 100), 0, 100) / 100;
  const md = o.mask?.data && o.mask.data.length === n ? o.mask.data : null, minv = !!o.mask?.invert;
  const out = new Uint8ClampedArray(n);
  for (let p = 0; p < n; p++) {
    const s = o.invertA ? 255 - A[p] : A[p], v = o.invertB ? 255 - B[p] : B[p];
    let t = opacity;
    if (md) t *= (minv ? 255 - md[p] : md[p]) / 255;
    out[p] = v + (lut[(s << 8) | v] - v) * t;
  }
  return out;
}
