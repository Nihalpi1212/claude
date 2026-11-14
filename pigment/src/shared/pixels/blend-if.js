// Advanced blending (Layer Style > Blending Options, Pigment 0.4; ARCHITECTURE.md "0.4 features", K.3 and J.1):
// Blend If ranges with split sliders, channel restriction, knockout and the per-pixel compositing step the
// compositor runs when a layer's blending options are not the defaults. Pure: ImageData-like objects
// ({ width, height, data: Uint8ClampedArray }, straight alpha) and typed arrays only, so it runs in Node.
import { blendImages, isBlendMode } from './blend.js';

/** The four Blend If channels, in the order of the dialog's menu. */
export const BLEND_IF_CHANNELS = Object.freeze(['gray', 'r', 'g', 'b']);
/** A range that hides nothing: [black0, black1, white0, white1]. */
export const FULL_RANGE = Object.freeze([0, 0, 255, 255]);

const clampByte = (v) => (Number.isFinite(v) ? Math.max(0, Math.min(255, Math.round(v))) : 0);

/**
 * A Blend If range made valid: four integers in 0..255 with black0 <= black1 and white0 <= white1, and neither
 * black half to the right of the matching white half (the dialog's sliders cannot cross).
 * @param {number[] | undefined} r
 * @returns {number[]}
 */
export function normalizeRange(r) {
  if (!Array.isArray(r) || r.length !== 4 || !r.every(Number.isFinite)) return FULL_RANGE.slice();
  let [b0, b1, w0, w1] = r.map(clampByte);
  if (b0 > b1) [b0, b1] = [b1, b0];
  if (w0 > w1) [w0, w1] = [w1, w0];
  if (b0 > w0) b0 = w0;
  if (b1 > w1) b1 = w1;
  return [b0, b1, w0, w1];
}

/** True when the range hides nothing. */
export function isFullRange(r) {
  const [b0, b1, w0, w1] = normalizeRange(r);
  return b0 === 0 && b1 === 0 && w0 === 255 && w1 === 255;
}

/**
 * How much of a pixel whose channel value is v shows through a Blend If range, 0..1. Values below black0 and above
 * white1 are hidden; a split slider (black0 < black1, white0 < white1) fades linearly between its halves; an unsplit
 * slider is a hard cut that keeps its own value (black0 = black1 = 50 hides 0..49 and keeps 50).
 * @param {number} v 0..255
 * @param {number[]} range [black0, black1, white0, white1]
 */
export function rangeWeight(v, range) {
  const [b0, b1, w0, w1] = range;
  let lo;
  if (v < b0) lo = 0;
  else if (v >= b1) lo = 1;
  else lo = (v - b0) / (b1 - b0);
  let hi;
  if (v > w1) hi = 0;
  else if (v <= w0) hi = 1;
  else hi = (w1 - v) / (w1 - w0);
  return lo < hi ? lo : hi;
}

/** The 256 weights of a range (rangeWeight for every byte value). */
export function rangeLut(range) {
  const r = normalizeRange(range);
  const lut = new Float32Array(256);
  for (let v = 0; v < 256; v++) lut[v] = rangeWeight(v, r);
  return lut;
}

/** True when no channel of `blendIf` (missing or partial) hides anything. */
export function isDefaultBlendIf(blendIf) {
  if (!blendIf || typeof blendIf !== 'object') return true;
  for (const c of BLEND_IF_CHANNELS) {
    const s = blendIf[c];
    if (!s) continue;
    if (s.this && !isFullRange(s.this)) return false;
    if (s.under && !isFullRange(s.under)) return false;
  }
  return true;
}

/** Photoshop's gray for Blend If: the Rec. 601 luma of the 8-bit channels, rounded. */
export function grayOf(r, g, b) {
  return (r * 0.299 + g * 0.587 + b * 0.114 + 0.5) | 0;
}

/**
 * The Blend If weight of every pixel: the product over the channels of the "This Layer" weight of `src` and the
 * "Underlying Layer" weight of `under` (the composite below the layer). Null when nothing is hidden.
 * @param {{ width: number, height: number, data: Uint8ClampedArray }} src
 * @param {{ width: number, height: number, data: Uint8ClampedArray } | null} under same size; null reads as black
 * @param {object} blendIf { gray, r, g, b: { this, under } }
 * @returns {Float32Array | null} width * height weights in 0..1
 */
export function blendIfWeights(src, under, blendIf) {
  if (isDefaultBlendIf(blendIf)) return null;
  const n = src.width * src.height;
  const w = new Float32Array(n).fill(1);
  const sd = src.data, ud = under ? under.data : null;
  for (const c of BLEND_IF_CHANNELS) {
    const s = blendIf[c];
    if (!s) continue;
    const thisLut = s.this && !isFullRange(s.this) ? rangeLut(s.this) : null;
    const underLut = s.under && !isFullRange(s.under) ? rangeLut(s.under) : null;
    if (!thisLut && !underLut) continue;
    const off = c === 'r' ? 0 : c === 'g' ? 1 : c === 'b' ? 2 : -1;
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      if (thisLut) w[i] *= thisLut[off < 0 ? grayOf(sd[p], sd[p + 1], sd[p + 2]) : sd[p + off]];
      if (underLut) {
        const v = !ud ? 0 : off < 0 ? grayOf(ud[p], ud[p + 1], ud[p + 2]) : ud[p + off];
        w[i] *= underLut[v];
      }
    }
  }
  return w;
}

/** True when some of R, G, B is switched off (`channels` missing or partial counts as all on). */
export function restrictsChannels(channels) {
  return !!channels && (channels.r === false || channels.g === false || channels.b === false);
}

/**
 * Channel restriction: the channels switched off keep what `before` held. ImageData is straight alpha, so the
 * restored channel keeps its premultiplied value (before's colour times before's alpha) under the new alpha: over an
 * opaque backdrop the channel is exactly the backdrop's, over transparency it stays 0.
 * @param {{ data: Uint8ClampedArray }} out modified in place
 * @param {{ data: Uint8ClampedArray }} before the same pixels before the layer was drawn
 * @param {{ r?: boolean, g?: boolean, b?: boolean }} channels
 */
export function restrictChannels(out, before, channels) {
  if (!restrictsChannels(channels)) return out;
  const offs = [];
  if (channels.r === false) offs.push(0);
  if (channels.g === false) offs.push(1);
  if (channels.b === false) offs.push(2);
  const o = out.data, b = before.data;
  for (let p = 0; p < o.length; p += 4) {
    const ao = o[p + 3];
    if (ao === 0) continue;
    const ab = b[p + 3];
    for (const k of offs) {
      if (ab === ao) o[p + k] = b[p + k];
      else {
        const v = (b[p + k] * ab) / ao;
        o[p + k] = v > 255 ? 255 : (v + 0.5) | 0;
      }
    }
  }
  return out;
}

/**
 * Knockout: lerps `dst` towards `knock` (what the layer knocks out to: the bottom of its group or the Background)
 * by amount[i] / 255 * opacity, in premultiplied space so a transparent side contributes no colour.
 * @param {{ data: Uint8ClampedArray }} dst modified in place
 * @param {{ data: Uint8ClampedArray } | null} knock same size; null = transparency
 * @param {Uint8ClampedArray | Float32Array} amount one value per pixel, 0..255 (the layer's shape alpha)
 * @param {number} [opacity=1]
 */
export function knockoutInto(dst, knock, amount, opacity = 1) {
  const d = dst.data, k = knock ? knock.data : null;
  const op = Math.max(0, Math.min(1, Number.isFinite(opacity) ? opacity : 1));
  if (op <= 0) return dst;
  for (let i = 0, p = 0; p < d.length; i++, p += 4) {
    const t = (amount[i] / 255) * op;
    if (t <= 0) continue;
    const kr = k ? k[p] : 0, kg = k ? k[p + 1] : 0, kb = k ? k[p + 2] : 0, ka = k ? k[p + 3] : 0;
    if (t >= 1) {
      d[p] = kr;
      d[p + 1] = kg;
      d[p + 2] = kb;
      d[p + 3] = ka;
      continue;
    }
    const a0 = d[p + 3] / 255, a1 = ka / 255;
    const w0 = a0 * (1 - t), w1 = a1 * t;
    const an = w0 + w1;
    if (an <= 0) {
      d[p] = d[p + 1] = d[p + 2] = d[p + 3] = 0;
      continue;
    }
    // Uint8ClampedArray rounds on assignment
    d[p] = (d[p] * w0 + kr * w1) / an;
    d[p + 1] = (d[p + 1] * w0 + kg * w1) / an;
    d[p + 2] = (d[p + 2] * w0 + kb * w1) / an;
    d[p + 3] = an * 255;
  }
  return dst;
}

/**
 * Which mask parts apply before the layer effects and which after (K.3), from the two "Hides Effects" check boxes.
 * Both off: 'all' before (0.3: a stroke follows the mask edge); both on: 'all' after; one on: the part whose box is
 * off before and the part whose box is on after. null = nothing at that stage.
 * @param {{ maskHidesEffects?: boolean, vectorMaskHidesEffects?: boolean } | null} blending
 * @returns {{ before: 'all' | 'raster' | 'vector' | null, after: 'all' | 'raster' | 'vector' | null }}
 */
export function maskPartsAround(blending) {
  const m = !!blending?.maskHidesEffects, v = !!blending?.vectorMaskHidesEffects;
  if (!m && !v) return { before: 'all', after: null };
  if (m && v) return { before: null, after: 'all' };
  return m ? { before: 'vector', after: 'raster' } : { before: 'raster', after: 'vector' };
}

/** The bounding box of the pixels whose alpha is not 0, or null (Transparency Shapes Layer off uses the box). */
export function alphaBox(img) {
  const { width: w, height: h, data: d } = img;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    let p = y * w * 4 + 3;
    for (let x = 0; x < w; x++, p += 4) {
      if (d[p] === 0) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      y1 = y;
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

/**
 * The per-pixel step of a layer whose blending options are not the defaults, on one region (every image the same
 * size, aligned):
 *   1. `below` (the exterior effects, when the layer was split) blends onto dst with the layer's mode and opacity;
 *   2. knockout: dst is replaced by `knock` (null = transparency) under the layer's shape (`shape`, alpha 0..255
 *      per pixel), by the shape alpha times the opacity;
 *   3. `layer` (the layer at its fill opacity with its interior effects) blends onto dst with its mode and opacity,
 *      its alpha weighted by Blend If (This Layer reads `layer`, Underlying Layer reads dst as it was before step 1);
 *   4. the channels switched off keep what dst held before step 1.
 * @param {{
 *   dst: object, layer: object | null, below?: object | null, knock?: object | null, shape?: Uint8ClampedArray | null,
 *   knockout?: 'none' | 'shallow' | 'deep', blendIf?: object | null, channels?: object | null,
 *   mode?: string, opacity?: number, seed?: number }} o
 * @returns {object} dst
 */
export function compositeAdvanced(o) {
  const { dst, layer } = o;
  const mode = o.mode === 'pass-through' || !isBlendMode(o.mode) ? 'normal' : o.mode;
  const opacity = Number.isFinite(o.opacity) ? Math.max(0, Math.min(1, o.opacity)) : 1;
  const restrict = restrictsChannels(o.channels);
  const needUnder = restrict || !isDefaultBlendIf(o.blendIf);
  const before = needUnder ? { width: dst.width, height: dst.height, data: new Uint8ClampedArray(dst.data) } : null;
  if (o.below) blendImages(mode, o.below, dst, opacity, null, o.seed ?? 1);
  if (o.knockout && o.knockout !== 'none' && o.shape) knockoutInto(dst, o.knock ?? null, o.shape, opacity);
  if (layer) {
    const w = blendIfWeights(layer, before, o.blendIf);
    let src = layer;
    if (w) {
      const d = new Uint8ClampedArray(layer.data);
      for (let i = 0, p = 3; i < w.length; i++, p += 4) if (w[i] < 1) d[p] = d[p] * w[i];
      src = { width: layer.width, height: layer.height, data: d };
    }
    blendImages(mode, src, dst, opacity, null, o.seed ?? 1);
  }
  if (restrict) restrictChannels(dst, before, o.channels);
  return dst;
}
