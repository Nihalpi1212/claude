// Blend modes. blendPixel() is the per-pixel reference for every Photoshop blend mode and
// blendImages() composites one ImageDataLike over another in place: source-over alpha maths
// around the blended colour, straight alpha in and out. The compositor uses blendImages() as the
// fallback whenever Canvas 2D has no globalCompositeOperation for a mode (see CANVAS_BLEND).
//
// Conventions: s = source (the layer being drawn), b = backdrop (what is already underneath).
// Separable formulas work per channel on 0..255 values; non-separable ones follow the W3C
// Compositing and Blending spec (SetLum / SetSat / ClipColor) using core.js's Rec. 601 luma.
// No DOM, no canvas: this runs in the renderer, in the pixel worker and in Node tests.

import { clamp255, clampRect, luminance, randomSeeded } from './core.js';

/** @typedef {import('./core.js').ImageDataLike} ImageDataLike */
/** @typedef {import('./core.js').Rect} Rect */
/**
 * @typedef {'normal'|'dissolve'|'darken'|'multiply'|'color-burn'|'linear-burn'|'darker-color'|
 *   'lighten'|'screen'|'color-dodge'|'linear-dodge'|'lighter-color'|'overlay'|'soft-light'|'hard-light'|
 *   'vivid-light'|'linear-light'|'pin-light'|'hard-mix'|'difference'|'exclusion'|'subtract'|'divide'|
 *   'hue'|'saturation'|'color'|'luminosity'} BlendMode
 */

/**
 * Every per-pixel blend mode, in the order Photoshop's layer menu lists them ('pass-through' is a
 * group-only setting and is accepted by blendPixel/blendImages as an alias of 'normal').
 * @type {readonly BlendMode[]}
 */
export const BLEND_MODES = Object.freeze([
  'normal', 'dissolve',
  'darken', 'multiply', 'color-burn', 'linear-burn', 'darker-color',
  'lighten', 'screen', 'color-dodge', 'linear-dodge', 'lighter-color',
  'overlay', 'soft-light', 'hard-light', 'vivid-light', 'linear-light', 'pin-light', 'hard-mix',
  'difference', 'exclusion', 'subtract', 'divide',
  'hue', 'saturation', 'color', 'luminosity',
]);

/**
 * Canvas 2D globalCompositeOperation that reproduces a mode, or null when the compositor has to
 * fall back to blendImages(). 'linear-dodge' has no equivalent: Canvas 'lighter' also adds the
 * alpha and ignores the opacity lerp once the sum clips; 'pass-through' groups that need their own
 * canvas are drawn with plain 'source-over'.
 * @type {Readonly<Record<BlendMode | 'pass-through', string | null>>}
 */
export const CANVAS_BLEND = Object.freeze({
  normal: 'source-over',
  dissolve: null,
  darken: 'darken',
  multiply: 'multiply',
  'color-burn': 'color-burn',
  'linear-burn': null,
  'darker-color': null,
  lighten: 'lighten',
  screen: 'screen',
  'color-dodge': 'color-dodge',
  'linear-dodge': null,
  'lighter-color': null,
  overlay: 'overlay',
  'soft-light': 'soft-light',
  'hard-light': 'hard-light',
  'vivid-light': null,
  'linear-light': null,
  'pin-light': null,
  'hard-mix': null,
  difference: 'difference',
  exclusion: 'exclusion',
  subtract: null,
  divide: null,
  hue: 'hue',
  saturation: 'saturation',
  color: 'color',
  luminosity: 'luminosity',
  'pass-through': 'source-over',
});

// ---------------------------------------------------------------------------------------------
// Separable modes: f(s, b) -> result, all three values 0..255 (floats allowed, result unclamped
// only where the formula cannot leave the range).

const multiply = (s, b) => (s * b) / 255;
const screen = (s, b) => s + b - (s * b) / 255;
const colorBurn = (s, b) => (b >= 255 ? 255 : s <= 0 ? 0 : 255 - Math.min(255, ((255 - b) * 255) / s));
const colorDodge = (s, b) => (b <= 0 ? 0 : s >= 255 ? 255 : Math.min(255, (b * 255) / (255 - s)));
const hardLight = (s, b) => (s <= 127.5 ? multiply(2 * s, b) : screen(2 * s - 255, b));
// W3C soft light: D(b) = b <= 0.25 ? ((16b - 12)b + 4)b : sqrt(b), everything in 0..1.
const softLightD = (b) => (b <= 0.25 ? ((16 * b - 12) * b + 4) * b : Math.sqrt(b));
const softLight = (s, b) => {
  const S = s / 255, B = b / 255;
  return 255 * (S <= 0.5 ? B - (1 - 2 * S) * B * (1 - B) : B + (2 * S - 1) * (softLightD(B) - B));
};

/** @type {Record<string, (s: number, b: number) => number>} */
const SEPARABLE = {
  darken: (s, b) => Math.min(s, b),
  multiply,
  'color-burn': colorBurn,
  'linear-burn': (s, b) => Math.max(0, s + b - 255),
  lighten: (s, b) => Math.max(s, b),
  screen,
  'color-dodge': colorDodge,
  'linear-dodge': (s, b) => Math.min(255, s + b),
  overlay: (s, b) => hardLight(b, s),
  'soft-light': softLight,
  'hard-light': hardLight,
  'vivid-light': (s, b) => (s <= 127.5 ? colorBurn(2 * s, b) : colorDodge(2 * s - 255, b)),
  'linear-light': (s, b) => clamp255(b + 2 * s - 255),
  'pin-light': (s, b) => (s <= 127.5 ? Math.min(b, 2 * s) : Math.max(b, 2 * s - 255)),
  'hard-mix': (s, b) => (s + b >= 255 ? 255 : 0),
  difference: (s, b) => Math.abs(s - b),
  exclusion: (s, b) => s + b - (2 * s * b) / 255,
  subtract: (s, b) => Math.max(0, b - s),
  divide: (s, b) => (s <= 0 ? (b <= 0 ? 0 : 255) : Math.min(255, (b * 255) / s)),
};

// ---------------------------------------------------------------------------------------------
// Non-separable modes (W3C SetLum / SetSat / ClipColor in the 0..255 domain). Each function
// writes its result into the scratch variables R, G, B so the hot loop allocates nothing.

let R = 0, G = 0, B = 0;

/** W3C ClipColor: pulls a colour whose luma is l back into 0..255 without changing that luma. */
function clipColor(r, g, b, l) {
  const n = Math.min(r, g, b), x = Math.max(r, g, b);
  if (n < 0 && l - n > 0) {
    const k = l / (l - n);
    r = l + (r - l) * k;
    g = l + (g - l) * k;
    b = l + (b - l) * k;
  }
  if (x > 255 && x - l > 0) {
    const k = (255 - l) / (x - l);
    r = l + (r - l) * k;
    g = l + (g - l) * k;
    b = l + (b - l) * k;
  }
  R = r;
  G = g;
  B = b;
}

/** W3C SetLum: shifts the colour to luma l, then clips. */
function setLum(r, g, b, l) {
  const d = l - luminance(r, g, b);
  clipColor(r + d, g + d, b + d, l);
}

const sat = (r, g, b) => Math.max(r, g, b) - Math.min(r, g, b);

/** W3C SetSat: rescales the colour so max - min = s (min goes to 0); greys become black. */
function setSat(r, g, b, s) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  if (max > min) {
    const mid = ((r + g + b - max - min - min) * s) / (max - min);
    R = r === max ? s : r === min ? 0 : mid;
    G = g === max ? s : g === min ? 0 : mid;
    B = b === max ? s : b === min ? 0 : mid;
  } else R = G = B = 0;
}

/** @type {Record<string, (sr: number, sg: number, sb: number, br: number, bg: number, bb: number) => void>} */
const NON_SEPARABLE = {
  'darker-color': (sr, sg, sb, br, bg, bb) => {
    if (luminance(sr, sg, sb) < luminance(br, bg, bb)) { R = sr; G = sg; B = sb; } else { R = br; G = bg; B = bb; }
  },
  'lighter-color': (sr, sg, sb, br, bg, bb) => {
    if (luminance(sr, sg, sb) > luminance(br, bg, bb)) { R = sr; G = sg; B = sb; } else { R = br; G = bg; B = bb; }
  },
  hue: (sr, sg, sb, br, bg, bb) => {
    setSat(sr, sg, sb, sat(br, bg, bb));
    setLum(R, G, B, luminance(br, bg, bb));
  },
  saturation: (sr, sg, sb, br, bg, bb) => {
    setSat(br, bg, bb, sat(sr, sg, sb));
    setLum(R, G, B, luminance(br, bg, bb));
  },
  color: (sr, sg, sb, br, bg, bb) => setLum(sr, sg, sb, luminance(br, bg, bb)),
  luminosity: (sr, sg, sb, br, bg, bb) => setLum(br, bg, bb, luminance(sr, sg, sb)),
};

const NORMAL_LIKE = new Set(['normal', 'dissolve', 'pass-through']);

/** True for every value blendPixel/blendImages accept (the BlendMode union plus 'pass-through'). */
export function isBlendMode(mode) {
  return NORMAL_LIKE.has(mode) || Object.prototype.hasOwnProperty.call(SEPARABLE, mode) || Object.prototype.hasOwnProperty.call(NON_SEPARABLE, mode);
}

const unknownMode = (mode) => new RangeError(`Unknown blend mode: ${String(mode)}`);
const to8 = (v) => Math.round(clamp255(v)) || 0;

// ---------------------------------------------------------------------------------------------

const LUTS = new Map();

/**
 * 256x256 lookup table for a separable mode: lut[(s << 8) | b] = blend(s, b), 0..255. Built on
 * first use (64K evaluations) and cached; null for normal/dissolve and the non-separable modes.
 * @param {BlendMode} mode
 * @returns {Uint8ClampedArray | null}
 */
export function separableLut(mode) {
  const f = SEPARABLE[mode];
  if (!f) return null;
  let lut = LUTS.get(mode);
  if (!lut) {
    lut = new Uint8ClampedArray(65536);
    for (let s = 0; s < 256; s++) {
      const row = s << 8;
      for (let b = 0; b < 256; b++) lut[row | b] = Math.round(f(s, b));
    }
    LUTS.set(mode, lut);
  }
  return lut;
}

/**
 * Blends one source colour over one backdrop colour (no alpha involved) and returns the rounded
 * 0..255 result. 'dissolve' and 'pass-through' behave as 'normal' here; unknown modes throw.
 * @param {BlendMode | 'pass-through'} mode
 * @param {number} sr source red 0..255  @param {number} sg  @param {number} sb
 * @param {number} br backdrop red 0..255  @param {number} bg  @param {number} bb
 * @returns {[number, number, number]}
 */
export function blendPixel(mode, sr, sg, sb, br, bg, bb) {
  const f = SEPARABLE[mode];
  if (f) return [to8(f(sr, br)), to8(f(sg, bg)), to8(f(sb, bb))];
  const n = NON_SEPARABLE[mode];
  if (n) {
    n(sr, sg, sb, br, bg, bb);
    return [to8(R), to8(G), to8(B)];
  }
  if (NORMAL_LIKE.has(mode)) return [to8(sr), to8(sg), to8(sb)];
  throw unknownMode(mode);
}

/** Seed for the dissolve noise stream of one row: stable per (seed, y) whatever the rect is. */
const rowSeed = (seed, y) => (Math.imul((seed | 0) + 0x632be5ab, 0x9e3779b1) ^ Math.imul(y + 1, 0x85ebca6b)) >>> 0;

/**
 * Composites src over dst in place ("source-over" around the blended colour, straight alpha):
 *   sa = srcAlpha * opacity, da = dstAlpha
 *   ao = sa + da * (1 - sa)
 *   Co = (sa * (1 - da) * Cs + sa * da * blend(Cs, Cb) + (1 - sa) * da * Cb) / ao
 * which is (1 - sa) * Cb + sa * ((1 - da) * Cs + da * blend) when dst is opaque, leaves dst
 * untouched where src is transparent and yields src unchanged over transparent dst (no black
 * bleeding). 'dissolve' keeps each source pixel fully opaque with probability sa and drops it
 * otherwise, using randomSeeded noise that depends only on (seed, x, y), so partial repaints match
 * a full one. Both images must share a coordinate system; work is limited to rect (default: the
 * whole image) clipped to both images, and nothing outside it is read or written.
 * @param {BlendMode | 'pass-through'} mode
 * @param {ImageDataLike} src
 * @param {ImageDataLike} dst modified in place and returned
 * @param {number} [opacity=1] 0..1, multiplies the source alpha
 * @param {Rect | null} [rect]
 * @param {number} [seed=1] dissolve noise seed
 * @returns {ImageDataLike} dst
 */
export function blendImages(mode, src, dst, opacity = 1, rect = null, seed = 1) {
  if (!isBlendMode(mode)) throw unknownMode(mode);
  const op = opacity < 0 ? 0 : opacity > 1 ? 1 : +opacity || 0;
  if (op <= 0) return dst;
  const r = clampRect(rect, Math.min(src.width, dst.width), Math.min(src.height, dst.height));
  if (r.width <= 0 || r.height <= 0) return dst;
  const sd = src.data, dd = dst.data, sw = src.width, dw = dst.width;
  const lut = separableLut(mode);
  const fn = lut ? null : NON_SEPARABLE[mode] || null;
  const dissolve = mode === 'dissolve';
  const x0 = r.x, x1 = r.x + r.width, y1 = r.y + r.height;
  for (let y = r.y; y < y1; y++) {
    let si = (y * sw + x0) * 4, di = (y * dw + x0) * 4;
    let rnd = null;
    if (dissolve) {
      rnd = randomSeeded(rowSeed(seed, y));
      for (let k = 0; k < x0; k++) rnd();
    }
    for (let x = x0; x < x1; x++, si += 4, di += 4) {
      let sa = (sd[si + 3] / 255) * op;
      if (dissolve) {
        if (rnd() >= sa) continue; // one draw per pixel keeps the pattern position-stable
        sa = 1;
      } else if (sa <= 0) continue;
      const sr = sd[si], sg = sd[si + 1], sb = sd[si + 2];
      const br = dd[di], bg = dd[di + 1], bb = dd[di + 2];
      const da = dd[di + 3] / 255;
      let Br, Bg, Bb;
      if (lut) {
        Br = lut[(sr << 8) | br];
        Bg = lut[(sg << 8) | bg];
        Bb = lut[(sb << 8) | bb];
      } else if (fn) {
        fn(sr, sg, sb, br, bg, bb);
        Br = R; Bg = G; Bb = B;
      } else {
        Br = sr; Bg = sg; Bb = sb;
      }
      if (da >= 1) {
        dd[di] = (br + sa * (Br - br) + 0.5) | 0;
        dd[di + 1] = (bg + sa * (Bg - bg) + 0.5) | 0;
        dd[di + 2] = (bb + sa * (Bb - bb) + 0.5) | 0;
      } else if (da <= 0) {
        dd[di] = sr;
        dd[di + 1] = sg;
        dd[di + 2] = sb;
        dd[di + 3] = (sa * 255 + 0.5) | 0;
      } else {
        const ao = sa + da * (1 - sa);
        const ws = (sa * (1 - da)) / ao, wb = (sa * da) / ao, wd = ((1 - sa) * da) / ao;
        dd[di] = (ws * sr + wb * Br + wd * br + 0.5) | 0;
        dd[di + 1] = (ws * sg + wb * Bg + wd * bg + 0.5) | 0;
        dd[di + 2] = (ws * sb + wb * Bb + wd * bb + 0.5) | 0;
        dd[di + 3] = (ao * 255 + 0.5) | 0;
      }
    }
  }
  return dst;
}
