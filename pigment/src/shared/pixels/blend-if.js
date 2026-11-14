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
 * Fades `dst` back towards `before` (the same pixels before the layer was drawn): dst = lerp(before, dst, opacity),
 * in premultiplied space so a transparent side contributes no colour. Layer Opacity in Photoshop's model: the layer,
 * its effects and its knockout are faded as one from the backdrop.
 * @param {{ data: Uint8ClampedArray }} dst modified in place
 * @param {{ data: Uint8ClampedArray }} before same size
 * @param {number} opacity 0..1
 */
export function fadeFrom(dst, before, opacity) {
  const t = Math.max(0, Math.min(1, Number.isFinite(opacity) ? opacity : 1));
  if (t >= 1) return dst;
  const d = dst.data, b = before.data;
  for (let p = 0; p < d.length; p += 4) {
    const a1 = d[p + 3], a0 = b[p + 3];
    if (a0 === a1) {
      if (d[p] === b[p] && d[p + 1] === b[p + 1] && d[p + 2] === b[p + 2]) continue;
      d[p] = b[p] + (d[p] - b[p]) * t;
      d[p + 1] = b[p + 1] + (d[p + 1] - b[p + 1]) * t;
      d[p + 2] = b[p + 2] + (d[p + 2] - b[p + 2]) * t;
      continue;
    }
    const w0 = (a0 / 255) * (1 - t), w1 = (a1 / 255) * t;
    const an = w0 + w1;
    if (an <= 0) {
      d[p] = d[p + 1] = d[p + 2] = d[p + 3] = 0;
      continue;
    }
    // Uint8ClampedArray rounds on assignment
    d[p] = (b[p] * w0 + d[p] * w1) / an;
    d[p + 1] = (b[p + 1] * w0 + d[p + 1] * w1) / an;
    d[p + 2] = (b[p + 2] * w0 + d[p + 2] * w1) / an;
    d[p + 3] = an * 255;
  }
  return dst;
}

/**
 * The per-pixel step of a layer whose blending options are not the defaults, on one region (every image the same
 * size, aligned), in Photoshop's order:
 *   1. `parts` (the exterior effects, when the layer was split: drop shadows, outer glows, the outer bevel and the
 *      outer stroke, bottom first) blend onto dst one by one, each with its own mode and opacity. Blend If does not
 *      weigh them: it acts on the layer's own pixels (and its interior effects), as in Photoshop, where a shadow
 *      stays whole when Blend If hides part of the layer;
 *   2. knockout: dst is replaced by `knock` (null = transparency) under the layer's shape (`shape`, alpha 0..255
 *      per pixel);
 *   3. `layer` (the layer at its fill opacity with its interior effects) blends onto dst with the layer's mode, its
 *      alpha weighted by Blend If (This Layer reads `layer`, Underlying Layer reads dst as it was before step 1);
 *   3b. `inner` (the interior effects apart, Blend Interior Effects as Group off) blend onto dst one by one in their
 *      own modes, weighted by the same Blend If as the layer;
 *   4. the channels switched off keep what dst held before step 1;
 *   5. the layer's opacity fades all of that as one from dst before step 1 (Dissolve instead speckles the layer at
 *      its opacity and draws the parts at theirs times it).
 * Without parts, inner parts and knockout, steps 3 and 5 are one blendImages at the opacity, which is the same thing.
 * `below` (the exterior effects merged into one image, drawn with the layer's mode) without knockout keeps 0.3's
 * order: it and the layer each at the opacity (where the layer covers the merged effects they are knocked out, so
 * that is the one fade with 0.3's rounding); with knockout it is taken as a single part.
 * @param {{
 *   dst: object, layer: object | null, parts?: { image: object, blend?: string, opacity?: number }[] | null,
 *   inner?: { image: object, blend?: string, opacity?: number }[] | null,
 *   below?: object | null, knock?: object | null, shape?: Uint8ClampedArray | null,
 *   knockout?: 'none' | 'shallow' | 'deep', blendIf?: object | null, channels?: object | null,
 *   mode?: string, opacity?: number, seed?: number }} o
 * @returns {object} dst
 */
export function compositeAdvanced(o) {
  const { dst, layer } = o;
  const mode = o.mode === 'pass-through' || !isBlendMode(o.mode) ? 'normal' : o.mode;
  const opacity = Number.isFinite(o.opacity) ? Math.max(0, Math.min(1, o.opacity)) : 1;
  const restrict = restrictsChannels(o.channels);
  const merged = !o.parts?.length && !!o.below;
  const parts = o.parts?.length ? o.parts : merged ? [{ image: o.below, blend: mode, opacity: 1 }] : null;
  const inner = o.inner?.length ? o.inner : null;
  const knocks = !!(o.knockout && o.knockout !== 'none' && o.shape);
  const stacked = (!!parts && !merged) || knocks || !!inner;
  const needBefore = restrict || !isDefaultBlendIf(o.blendIf) || (stacked && opacity < 1);
  const before = needBefore ? { width: dst.width, height: dst.height, data: new Uint8ClampedArray(dst.data) } : null;
  const seed = o.seed ?? 1;
  // stacked: everything at full strength, then one fade by the opacity; else the layer alone at its opacity
  const dissolve = mode === 'dissolve';
  const strength = !stacked || dissolve ? opacity : 1;
  if (parts) {
    for (const p of parts) {
      const op = (Number.isFinite(p.opacity) ? Math.max(0, Math.min(1, p.opacity)) : 1) * (dissolve || !stacked ? opacity : 1);
      if (op > 0 && p.image) blendImages(isBlendMode(p.blend) ? p.blend : 'normal', p.image, dst, op, null, seed);
    }
  }
  if (knocks) knockoutInto(dst, o.knock ?? null, o.shape, dissolve ? opacity : 1);
  const weigh = (img, w) => {
    if (!w) return img;
    const d = new Uint8ClampedArray(img.data);
    for (let i = 0, p = 3; i < w.length; i++, p += 4) if (w[i] < 1) d[p] = d[p] * w[i];
    return { width: img.width, height: img.height, data: d };
  };
  const w = layer ? blendIfWeights(layer, before, o.blendIf) : null;
  if (layer) blendImages(mode, weigh(layer, w), dst, strength, null, seed);
  if (inner) {
    for (const p of inner) {
      const op = (Number.isFinite(p.opacity) ? Math.max(0, Math.min(1, p.opacity)) : 1) * (dissolve ? opacity : 1);
      if (op > 0 && p.image) blendImages(isBlendMode(p.blend) ? p.blend : 'normal', weigh(p.image, w), dst, op, null, seed);
    }
  }
  if (restrict) restrictChannels(dst, before, o.channels);
  if (stacked && !dissolve && opacity < 1) fadeFrom(dst, before, opacity);
  return dst;
}

// ---- adjustment layers -----------------------------------------------------------------------------------------

/**
 * The part of an adjustment layer's blending that changes how it mixes, or null when it mixes as 0.3 did (a lerp
 * towards the adjusted pixels by opacity × mask): Normal mode, Fill 100 %, no Blend If and all three channels.
 * Photoshop gives an adjustment layer the blend mode, Opacity, Fill, the channels and Blend If of Blending Options;
 * knockout and the five check boxes act on a layer's own pixels and effects, which an adjustment layer has none of.
 * @param {{ blend?: string, opacity?: number, fillOpacity?: number }} layer
 * @param {{ blendIf?: object | null, channels?: object | null } | null} blending the layer's (partial) blending options
 * @returns {{ mode: string, opacity: number, blendIf: object | null, channels: object | null } | null}
 *   opacity: the layer's opacity times its fill opacity (Fill scales an adjustment as Opacity does)
 */
export function adjustmentMix(layer, blending) {
  const mode = !layer?.blend || layer.blend === 'pass-through' || !isBlendMode(layer.blend) ? 'normal' : layer.blend;
  const fill = Number.isFinite(layer?.fillOpacity) ? Math.max(0, Math.min(1, layer.fillOpacity)) : 1;
  const blendIf = blending && !isDefaultBlendIf(blending.blendIf) ? blending.blendIf : null;
  const channels = blending && restrictsChannels(blending.channels) ? blending.channels : null;
  if (mode === 'normal' && fill >= 1 && !blendIf && !channels) return null;
  const opacity = Number.isFinite(layer?.opacity) ? Math.max(0, Math.min(1, layer.opacity)) : 1;
  return { mode, opacity: opacity * fill, blendIf, channels };
}

/** A noise value in [0, 1) for document pixel (x, y): Dissolve's speckles stay put whatever rect is repainted. */
function pixelNoise(seed, x, y) {
  let h = Math.imul((seed | 0) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(x + 0x632be5ab, 0xc2b2ae35) ^ Math.imul(y + 0x27d4eb2f, 0x165667b1);
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * Mixes an adjustment layer's result into the backdrop, in place, the way Photoshop composites an adjustment layer:
 * its "pixels" are the adjusted backdrop, blended onto the backdrop in the layer's mode at full strength (Normal:
 * the adjusted colour itself), then mixed in by
 *   opacity (layer opacity × fill opacity) × coverage (mask, and a clipping base's shape) × Blend If,
 * where Blend If's This Layer reads the adjusted pixels and Underlying Layer the backdrop. The channels switched off
 * keep the backdrop's values. Dissolve keeps the adjusted colour where a position-stable noise value falls below that
 * weight and the backdrop elsewhere. ImageData is straight alpha: where the two alphas differ the mix is
 * premultiplied, as compositor.js lerpPixels does; with Normal, no Blend If and all channels it is that lerp exactly.
 * @param {{ width: number, height: number, data: Uint8ClampedArray }} dst the backdrop, replaced by the result
 * @param {{ width: number, height: number, data: Uint8ClampedArray }} adjusted the adjustment run on a copy of dst
 * @param {{ mode?: string, opacity?: number, coverage?: ArrayLike<number> | null, blendIf?: object | null,
 *   channels?: object | null, seed?: number, x?: number, y?: number }} [o] coverage: one value per pixel, 0..255
 *   (null: everywhere); x, y: where dst's (0, 0) is in the document (Dissolve's noise)
 * @returns {object} dst
 */
export function mixAdjustment(dst, adjusted, o = {}) {
  const mode = !o.mode || o.mode === 'pass-through' || !isBlendMode(o.mode) ? 'normal' : o.mode;
  const op = Number.isFinite(o.opacity) ? Math.max(0, Math.min(1, o.opacity)) : 1;
  if (!(op > 0)) return dst;
  const d = dst.data, a = adjusted.data, cov = o.coverage ?? null;
  const w = blendIfWeights(adjusted, dst, o.blendIf);
  const keep = restrictsChannels(o.channels) ? [o.channels.r === false, o.channels.g === false, o.channels.b === false] : null;
  const dissolve = mode === 'dissolve';
  const plain = mode === 'normal' || dissolve;
  // the blended colour per mode: separable modes through their table, the others pixel by pixel (blendImages over an
  // opaque copy: the full-strength blend of the adjusted colour onto the backdrop's colour)
  let blended = null;
  if (!plain) {
    const n = dst.width * dst.height;
    const src = new Uint8ClampedArray(a), back = new Uint8ClampedArray(d);
    for (let p = 3; p < n * 4; p += 4) src[p] = back[p] = 255;
    blendImages(mode, { width: dst.width, height: dst.height, data: src }, { width: dst.width, height: dst.height, data: back }, 1);
    blended = back;
  }
  const W = dst.width, x0 = o.x ?? 0, y0 = o.y ?? 0, seed = o.seed ?? 1;
  const C = [0, 0, 0];
  for (let i = 0, p = 0; p < d.length; i++, p += 4) {
    let t = op * (cov ? cov[i] / 255 : 1) * (w ? w[i] : 1);
    if (!(t > 0)) continue;
    if (dissolve) {
      if (pixelNoise(seed, x0 + (i % W), y0 + ((i / W) | 0)) >= t) continue;
      t = 1;
    }
    const src = blended ?? a;
    C[0] = keep?.[0] ? d[p] : src[p];
    C[1] = keep?.[1] ? d[p + 1] : src[p + 1];
    C[2] = keep?.[2] ? d[p + 2] : src[p + 2];
    const ca = a[p + 3];
    if (t >= 1) {
      d[p] = C[0];
      d[p + 1] = C[1];
      d[p + 2] = C[2];
      d[p + 3] = ca;
    } else if (d[p + 3] === ca) {
      // Uint8ClampedArray rounds on assignment: the same expression as lerpPixels, so a Fill-only mix matches it
      d[p] += (C[0] - d[p]) * t;
      d[p + 1] += (C[1] - d[p + 1]) * t;
      d[p + 2] += (C[2] - d[p + 2]) * t;
    } else {
      const a0 = d[p + 3] / 255, a1 = ca / 255;
      const w0 = a0 * (1 - t), w1 = a1 * t;
      const an = w0 + w1;
      if (an <= 0) {
        d[p] = d[p + 1] = d[p + 2] = d[p + 3] = 0;
        continue;
      }
      d[p] = (d[p] * w0 + C[0] * w1) / an;
      d[p + 1] = (d[p + 1] * w0 + C[1] * w1) / an;
      d[p + 2] = (d[p + 2] * w0 + C[2] * w1) / an;
      d[p + 3] = an * 255;
    }
  }
  return dst;
}
