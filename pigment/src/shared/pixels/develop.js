// Camera Raw style "develop" pipeline (see ARCHITECTURE.md "0.2 features: Camera Raw filter" and "0.5 features", S8.1).
//
// develop(img, params, rect?) edits an ImageDataLike in place. Since 0.5 it is the loop over the registered develop
// stages (develop-stages.js); this file registers 0.4's controls as builtin stages, in the order Lightroom / Camera Raw
// applies them: white balance and exposure in linear light, then the tone controls (contrast, highlights/shadows/
// whites/blacks) on perceptual luminance, local contrast (texture, clarity, dehaze), colour (vibrance, saturation, HSL
// per hue range, treatment), detail (noise reduction, sharpening) and finally the effects (vignette, grain). Every
// stage is skipped when its control sits at the neutral value, so the defaults are an exact no-op, and with these
// stages the output is 0.4's (tests/unit/develop-stages.test.mjs compares it with a frozen copy of 0.4's function).
//
// Pixels are processed as straight-alpha float RGB; the builtins never change alpha. Pure JS, no DOM, so the same code
// runs in the renderer and in the Node unit tests. 0.4's helpers live in develop-util.js; this file re-exports what it
// exported in 0.4. Skeleton file (camera-raw-panels and camera-raw-workspace register their stages from
// develop-more.js and develop-profile.js, imported below before the builtins).
import { registerDevelopStage, developStages, developDefaults, normalizeDevelopParams, developNeutral, develop, mapToSource, developMargin } from './develop-stages.js';
import './develop-more.js'; // camera-raw-panels (S8.1): its stages register before the builtins
import './develop-profile.js'; // camera-raw-workspace (S8.4): the profile stage
import { intersectRect } from './core.js';
import {
  HSL_RANGES, DEVELOP_DEFAULTS, neutralHsl, num, clamp, clamp01, smoothstep, TO_LINEAR, toSrgbExact, toLinear, LUMA_R, LUMA_G, LUMA_B,
  shadowsSafe, luma, scaleToLuma, applyLumaCurve, textureContrast, localContrast, gaussianBlurFloat, saturate, applyHsl, hslRangeWeights,
  denoise, randomSeeded,
} from './develop-util.js';

export { HSL_RANGES, DEVELOP_DEFAULTS, gaussianBlurFloat, hslRangeWeights, toLinear, developDefaults, develop };
export { toSrgbExact as toSrgb };
export { registerDevelopStage, developStages, normalizeDevelopParams, mapToSource, developMargin };

/** 0.4's name: fills in missing keys (nested objects too) so partially specified params are safe to use. */
export const normalizeParams = (params = {}) => normalizeDevelopParams(params);

/** True when every control is at its neutral value. */
export const isNeutral = (params) => developNeutral(params);

// ---- 0.4's controls as builtin stages ------------------------------------------------------------------------
// neutral(p) is 0.4's isNeutral() for the stage's keys (any value other than 0 runs the stage, as 0.4 then unpacked
// and packed the image); apply() is 0.4's code for that step, with its own clamped test kept.

const any = (...v) => v.some((x) => num(x) !== 0);
const xmpNumber = (name) => ({ name, type: 'number' });
const RANGE_XMP = { reds: 'Red', oranges: 'Orange', yellows: 'Yellow', greens: 'Green', aquas: 'Aqua', blues: 'Blue', purples: 'Purple', magentas: 'Magenta' };
const MODE_XMP = { hue: 'Hue', saturation: 'Saturation', luminance: 'Luminance' };
// 0.4's dialog read a fixed 48 px around a selection (lib/develop-ui.js); the neighbourhood stages declare it
const NEIGHBOURHOOD = () => 48;
const B = { builtin: true };

registerDevelopStage({
  id: 'white-balance',
  order: 100,
  space: 'linear',
  params: { keys: ['temperature', 'tint'], defaults: () => ({ temperature: 0, tint: 0 }) },
  neutral: (p) => !any(p.temperature, p.tint),
  // white balance in linear light: temperature trades red against blue (yellow <-> blue), tint trades green against
  // magenta; the gains are normalised so a mid grey keeps its luminance.
  apply({ R, G, B: Bl }, p) {
    const n = R.length;
    const temp = clamp(num(p.temperature), -100, 100) / 100, tint = clamp(num(p.tint), -100, 100) / 100;
    if (!(temp || tint)) return;
    let gr = 1 + 0.3 * temp, gb = 1 - 0.3 * temp, gg = 1 - 0.2 * tint;
    if (tint) {
      gr *= 1 + 0.1 * tint;
      gb *= 1 + 0.1 * tint;
    }
    const lum = LUMA_R * gr + LUMA_G * gg + LUMA_B * gb;
    gr /= lum;
    gg /= lum;
    gb /= lum;
    for (let i = 0; i < n; i++) {
      R[i] *= gr;
      G[i] *= gg;
      Bl[i] *= gb;
    }
  },
  xmp: { temperature: xmpNumber('crs:IncrementalTemperature'), tint: xmpNumber('crs:IncrementalTint') },
}, B);

registerDevelopStage({
  id: 'exposure',
  order: 200,
  space: 'linear',
  params: { keys: ['exposure'], defaults: () => ({ exposure: 0 }) },
  neutral: (p) => !any(p.exposure),
  // exposure: a plain multiplier in linear light (one stop doubles the light)
  apply({ R, G, B: Bl }, p) {
    const n = R.length;
    const ev = clamp(num(p.exposure), -5, 5);
    if (!ev) return;
    const k = Math.pow(2, ev);
    for (let i = 0; i < n; i++) {
      R[i] *= k;
      G[i] *= k;
      Bl[i] *= k;
    }
  },
  xmp: { exposure: xmpNumber('crs:Exposure2012') },
}, B);

registerDevelopStage({
  id: 'tone',
  order: 300,
  space: 'perceptual',
  params: { keys: ['contrast', 'highlights', 'shadows', 'whites', 'blacks'], defaults: () => ({ contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0 }) },
  neutral: (p) => !any(p.contrast, p.highlights, p.shadows, p.whites, p.blacks),
  // tone: every control computes a new luminance from the old one and scales RGB by the ratio, which keeps hue and
  // (mostly) saturation; the masks make highlights only touch bright pixels and shadows only dark ones.
  apply({ R, G, B: Bl }, p) {
    const n = R.length;
    const contrast = clamp(num(p.contrast), -100, 100) / 100;
    const highlights = clamp(num(p.highlights), -100, 100) / 100;
    const shadows = clamp(num(p.shadows), -100, 100) / 100;
    const whites = clamp(num(p.whites), -100, 100) / 100;
    const blacks = clamp(num(p.blacks), -100, 100) / 100;
    if (!(contrast || highlights || shadows || whites || blacks)) return;
    const curve = new Float32Array(1025);
    for (let i = 0; i <= 1024; i++) {
      let L = i / 1024;
      // blacks / whites move the end points with weights that fade towards the other end
      if (blacks) {
        const wgt = (1 - L) * (1 - L);
        L += blacks * 0.25 * wgt;
      }
      if (whites) {
        const wgt = L * L;
        L += whites * 0.25 * wgt;
      }
      L = clamp01(L);
      // shadows lift (or deepen) the dark end with a mask that is gone above the midtones
      if (shadows) {
        const wgt = 1 - smoothstep(0.1, 0.65, L);
        L += shadows * 0.35 * wgt * (1 - L);
      }
      // highlights recover (or push) the bright end with a mask that starts in the midtones
      if (highlights) {
        const wgt = smoothstep(0.35, 0.9, L);
        L += highlights * 0.35 * wgt * (shadowsSafe(L));
      }
      L = clamp01(L);
      // contrast: an S-curve around middle grey (positive) or a flattening towards it (negative)
      if (contrast > 0) {
        const s = L * L * (3 - 2 * L);
        L = L + (s - L) * contrast;
      } else if (contrast < 0) {
        L = L + (0.5 + (L - 0.5) * 0.6 - L) * -contrast;
      }
      curve[i] = clamp01(L);
    }
    applyLumaCurve(R, G, Bl, n, curve);
  },
  xmp: {
    contrast: xmpNumber('crs:Contrast2012'), highlights: xmpNumber('crs:Highlights2012'), shadows: xmpNumber('crs:Shadows2012'),
    whites: xmpNumber('crs:Whites2012'), blacks: xmpNumber('crs:Blacks2012'),
  },
}, B);

registerDevelopStage({
  id: 'texture-clarity',
  order: 400,
  space: 'perceptual',
  params: { keys: ['texture', 'clarity'], defaults: () => ({ texture: 0, clarity: 0 }) },
  neutral: (p) => !any(p.texture, p.clarity),
  margin: NEIGHBOURHOOD,
  // local contrast: texture (small radius), clarity (about 1 % of the long edge)
  apply({ R, G, B: Bl, w, h }, p) {
    const n = R.length;
    const long = Math.max(w, h);
    const texture = clamp(num(p.texture), -100, 100) / 100;
    const clarity = clamp(num(p.clarity), -100, 100) / 100;
    if (!(texture || clarity)) return;
    const L = luma(R, G, Bl, n);
    const out = new Float32Array(L);
    if (texture) textureContrast(L, out, w, h, Math.max(0.8, long * 0.003), texture);
    if (clarity) localContrast(out.slice(), out, w, h, Math.max(1.5, long * 0.01), clarity * 0.8, 0);
    scaleToLuma(R, G, Bl, L, out, n);
  },
  xmp: { texture: xmpNumber('crs:Texture'), clarity: xmpNumber('crs:Clarity2012') },
}, B);

registerDevelopStage({
  id: 'dehaze',
  order: 450,
  space: 'perceptual',
  params: { keys: ['dehaze'], defaults: () => ({ dehaze: 0 }) },
  neutral: (p) => !any(p.dehaze),
  // haze is a lift of the black point and a loss of contrast and saturation: removing it subtracts a black level and
  // stretches what is left (and the reverse adds it back). Process version 1 (camera-raw-panels' dark-channel method
  // is version 2 only).
  apply({ R, G, B: Bl }, p) {
    const n = R.length;
    const dehaze = clamp(num(p.dehaze), -100, 100) / 100;
    if (!dehaze) return;
    const k = 0.25 * Math.abs(dehaze);
    if (dehaze > 0) {
      for (let i = 0; i < n; i++) {
        R[i] = clamp01((R[i] - k) / (1 - k));
        G[i] = clamp01((G[i] - k) / (1 - k));
        Bl[i] = clamp01((Bl[i] - k) / (1 - k));
      }
      saturate(R, G, Bl, n, 0.2 * dehaze, 0);
    } else {
      for (let i = 0; i < n; i++) {
        R[i] = R[i] * (1 - k) + k;
        G[i] = G[i] * (1 - k) + k;
        Bl[i] = Bl[i] * (1 - k) + k;
      }
      saturate(R, G, Bl, n, 0.2 * dehaze, 0);
    }
  },
  xmp: { dehaze: xmpNumber('crs:Dehaze') },
}, B);

registerDevelopStage({
  id: 'vibrance-saturation',
  order: 500,
  space: 'perceptual',
  params: { keys: ['vibrance', 'saturation'], defaults: () => ({ vibrance: 0, saturation: 0 }) },
  neutral: (p) => !any(p.vibrance, p.saturation),
  // colour: vibrance (saturates muted colours more than vivid ones) and saturation
  apply({ R, G, B: Bl }, p) {
    const vibrance = clamp(num(p.vibrance), -100, 100) / 100;
    const saturation = clamp(num(p.saturation), -100, 100) / 100;
    if (vibrance || saturation) saturate(R, G, Bl, R.length, saturation, vibrance);
  },
  xmp: { vibrance: xmpNumber('crs:Vibrance'), saturation: xmpNumber('crs:Saturation') },
}, B);

const hslActive = (hsl) => HSL_RANGES.some((k) => num(hsl[k].hue) || num(hsl[k].saturation) || num(hsl[k].luminance));
registerDevelopStage({
  id: 'hsl',
  order: 510,
  space: 'perceptual',
  params: {
    keys: ['hsl'],
    defaults: () => ({ hsl: neutralHsl() }),
    normalize(p) {
      const hsl = { ...neutralHsl(), ...(p.hsl ?? {}) };
      for (const k of HSL_RANGES) hsl[k] = { hue: 0, saturation: 0, luminance: 0, ...(p.hsl?.[k] ?? {}) };
      return { hsl };
    },
  },
  neutral: (p) => !hslActive(p.hsl),
  apply({ R, G, B: Bl }, p) {
    if (hslActive(p.hsl)) applyHsl(R, G, Bl, R.length, p.hsl);
  },
  xmp: Object.fromEntries(HSL_RANGES.flatMap((r) => Object.keys(MODE_XMP).map((m) => [`hsl.${r}.${m}`, xmpNumber(`crs:${MODE_XMP[m]}Adjustment${RANGE_XMP[r]}`)]))),
}, B);

// Treatment (S8.1): 'bw' mixes a grey from the colour with 0.3's Black & White default weights (Image > Adjustments >
// Black & White: reds 40, yellows 60, greens 40, cyans 60, blues 20, magentas 80). camera-raw-panels re-registers it
// with the Color Mixer's `bwMix`; the workspace's B&W button only sets `treatment`.
const BW = Object.freeze({ reds: 0.4, yellows: 0.6, greens: 0.4, cyans: 0.6, blues: 0.2, magentas: 0.8 });
registerDevelopStage({
  id: 'treatment',
  order: 520,
  space: 'perceptual',
  params: { keys: ['treatment'], defaults: () => ({ treatment: 'color' }), normalize: (p) => ({ treatment: p.treatment === 'bw' ? 'bw' : 'color' }) },
  neutral: (p) => p.treatment !== 'bw',
  apply({ R, G, B: Bl }) {
    const { reds: wR, yellows: wY, greens: wG, cyans: wC, blues: wB, magentas: wM } = BW;
    for (let i = 0; i < R.length; i++) {
      const rr = R[i], gg = G[i], bb = Bl[i];
      // grey = min + (mid - min) * secondary + (max - mid) * primary (0.3's adjust-color.js blackWhite)
      let grey;
      if (rr >= gg) {
        if (gg >= bb) grey = bb + (gg - bb) * wY + (rr - gg) * wR;
        else if (rr >= bb) grey = gg + (bb - gg) * wM + (rr - bb) * wR;
        else grey = gg + (rr - gg) * wM + (bb - rr) * wB;
      } else if (rr >= bb) grey = bb + (rr - bb) * wY + (gg - rr) * wG;
      else if (gg >= bb) grey = rr + (bb - rr) * wC + (gg - bb) * wG;
      else grey = rr + (gg - rr) * wC + (bb - gg) * wB;
      R[i] = G[i] = Bl[i] = clamp01(grey);
    }
  },
  xmp: { treatment: { name: 'crs:ConvertToGrayscale', type: 'bool', encode: (v) => v === 'bw', decode: (x) => (x === true || x === 'True' || x === 'true' ? 'bw' : 'color') } },
}, B);

registerDevelopStage({
  id: 'noise',
  order: 600,
  space: 'perceptual',
  params: {
    keys: ['noise'],
    defaults: () => ({ noise: { ...DEVELOP_DEFAULTS.noise } }),
    normalize: (p) => ({ noise: { ...DEVELOP_DEFAULTS.noise, ...(p.noise ?? {}) } }),
  },
  neutral: (p) => !any(p.noise.luminance, p.noise.color),
  margin: NEIGHBOURHOOD,
  // detail: noise reduction before sharpening so the sharpening does not amplify the noise
  apply({ R, G, B: Bl, w, h }, p) {
    const nl = clamp(num(p.noise.luminance), 0, 100) / 100, nc = clamp(num(p.noise.color), 0, 100) / 100;
    if (nl || nc) denoise(R, G, Bl, w, h, nl, nc);
  },
  xmp: { 'noise.luminance': xmpNumber('crs:LuminanceSmoothing'), 'noise.color': xmpNumber('crs:ColorNoiseReduction') },
}, B);

registerDevelopStage({
  id: 'sharpen',
  order: 650,
  space: 'perceptual',
  params: {
    keys: ['sharpen'],
    defaults: () => ({ sharpen: { ...DEVELOP_DEFAULTS.sharpen } }),
    normalize: (p) => ({ sharpen: { ...DEVELOP_DEFAULTS.sharpen, ...(p.sharpen ?? {}) } }),
  },
  neutral: (p) => !any(p.sharpen.amount),
  margin: NEIGHBOURHOOD,
  apply({ R, G, B: Bl, w, h }, p) {
    const n = R.length;
    const sharpenAmount = clamp(num(p.sharpen.amount), 0, 150) / 100;
    if (!sharpenAmount) return;
    const L = luma(R, G, Bl, n);
    const out = new Float32Array(L);
    const detail = clamp(num(p.sharpen.detail), 0, 100) / 100;
    // low detail masks flat areas (a contrast threshold) so only edges sharpen
    localContrast(L, out, w, h, clamp(num(p.sharpen.radius) || 1, 0.5, 3), sharpenAmount, (1 - detail) * 0.06);
    scaleToLuma(R, G, Bl, L, out, n);
  },
  xmp: { 'sharpen.amount': xmpNumber('crs:Sharpness'), 'sharpen.radius': xmpNumber('crs:SharpenRadius'), 'sharpen.detail': xmpNumber('crs:SharpenDetail') },
}, B);

registerDevelopStage({
  id: 'vignette',
  order: 700,
  space: 'perceptual',
  params: { keys: ['vignette'], defaults: () => ({ vignette: 0 }) },
  neutral: (p) => !any(p.vignette),
  // effects: vignette (elliptical, feathered from 40 % of the half diagonal); negative darkens the corners
  apply({ R, G, B: Bl, w, h }, p) {
    const vignette = clamp(num(p.vignette), -100, 100) / 100;
    if (!vignette) return;
    const cx = (w - 1) / 2, cy = (h - 1) / 2;
    const rx = Math.max(1, w / 2), ry = Math.max(1, h / 2);
    for (let y = 0, i = 0; y < h; y++) {
      const dy = (y - cy) / ry;
      for (let x = 0; x < w; x++, i++) {
        const dx = (x - cx) / rx;
        const d = Math.sqrt(dx * dx + dy * dy) / Math.SQRT2; // 0 centre .. 1 corner
        const wgt = smoothstep(0.35, 1, d);
        if (!wgt) continue;
        const f = vignette < 0 ? 1 + vignette * 0.85 * wgt : 1 + vignette * 0.6 * wgt;
        R[i] = clamp01(R[i] * f);
        G[i] = clamp01(G[i] * f);
        Bl[i] = clamp01(Bl[i] * f);
      }
    }
  },
  xmp: { vignette: xmpNumber('crs:PostCropVignetteAmount') },
}, B);

registerDevelopStage({
  id: 'grain',
  order: 800,
  space: 'perceptual',
  params: { keys: ['grain', 'seed'], defaults: () => ({ grain: 0, seed: 1 }) },
  neutral: (p) => !any(p.grain),
  apply({ R, G, B: Bl }, p) {
    const n = R.length;
    const grain = clamp(num(p.grain), 0, 100) / 100;
    if (!grain) return;
    const rnd = randomSeeded(num(p.seed) || 1);
    const amp = grain * 0.18;
    for (let i = 0; i < n; i++) {
      // triangular noise (sum of two uniforms) looks like film grain and avoids a flat histogram
      const g = (rnd() + rnd() - 1) * amp;
      // grain is weaker in the deep shadows and highlights, like film
      const L = LUMA_R * R[i] + LUMA_G * G[i] + LUMA_B * Bl[i];
      const k = g * (0.4 + 0.6 * Math.sin(Math.PI * L));
      R[i] = clamp01(R[i] + k);
      G[i] = clamp01(G[i] + k);
      Bl[i] = clamp01(Bl[i] + k);
    }
  },
  xmp: { grain: xmpNumber('crs:GrainAmount'), seed: xmpNumber('crs:GrainSeed') },
}, B);

/**
 * Auto tone: derives exposure, contrast, whites and blacks from the luminance histogram the way
 * Auto Levels / Auto Contrast clip 0.1 % at each end, plus an exposure that moves the mean towards
 * middle grey. Returns a params patch (never touches colour or detail settings).
 */
export function autoTone(img, { clip = 0.1 } = {}, rect = null) {
  const r = rect ? intersectRect(rect, { x: 0, y: 0, width: img.width, height: img.height }) : { x: 0, y: 0, width: img.width, height: img.height };
  const hist = new Uint32Array(256);
  let count = 0, sumLin = 0;
  const d = img.data;
  if (r) {
    for (let y = r.y; y < r.y + r.height; y++) {
      for (let x = r.x; x < r.x + r.width; x++) {
        const o = (y * img.width + x) * 4;
        if (d[o + 3] === 0) continue;
        const l = Math.round(0.299 * d[o] + 0.587 * d[o + 1] + 0.114 * d[o + 2]);
        hist[l]++;
        sumLin += TO_LINEAR[l];
        count++;
      }
    }
  }
  if (!count) return {};
  const clipN = (count * clip) / 100;
  let lo = 0, hi = 255, cum = 0;
  for (let v = 0; v < 256; v++) {
    cum += hist[v];
    if (cum > clipN) {
      lo = v;
      break;
    }
  }
  cum = 0;
  for (let v = 255; v >= 0; v--) {
    cum += hist[v];
    if (cum > clipN) {
      hi = v;
      break;
    }
  }
  const out = {};
  // exposure: bring the linear mean to 18 % grey, within ±1.5 EV so a dark subject stays dark
  const mean = sumLin / count;
  if (mean > 0.001) out.exposure = Math.round(clamp(Math.log2(0.18 / mean), -1.5, 1.5) * 20) / 20;
  // blacks / whites: push the clip points to the ends (the tone curve moves ±25 % at ±100)
  out.blacks = Math.round(clamp(-(lo / 255) / 0.25 * 100, -100, 0)) || 0;
  out.whites = Math.round(clamp(((255 - hi) / 255) / 0.25 * 100, 0, 100)) || 0;
  // a gentle contrast boost when the histogram is narrow
  const spread = (hi - lo) / 255;
  out.contrast = Math.round(clamp((1 - spread) * 60, 0, 40));
  return out;
}
