// Colour transforms of icc-engine (ARCHITECTURE.md "0.5 features", package 4, S6.1, S6.4, S6.5): what
// `engine.transform(from, to, opts)` returns, the Lab conversions and single colours.
//
// Two ways to convert, chosen per profile pair:
// - Matrix/TRC RGB and Gray profiles (every generated profile and almost every RGB working or display profile) go
//   through JavaScript kernels: tone curves as tables, one 3x3 matrix, an output table of 16385 linear steps. Their 8-bit results equal LittleCMS's own for these profiles (tests/unit/icc-engine.test.mjs checks
//   it on a million pixels), and they are what makes the display stage fast enough for S6.4's 60 ms: a wasm call
//   costs the copy into and out of its heap on top of the same arithmetic.
// - Everything else (LUT-based profiles, absolute colorimetric, 16-bit and float pixels) goes to LittleCMS.
// A Gray profile's numbers are tones: its curve is applied to each channel (S6.7).
import { parseIcc, modelOf, builtinIcc, evalCurve, invertCurve, invert3, xyzToLab, labToXyz } from './profiles.js';
import { lcms, lcmsTransform, runTransform, TYPE } from './lcms.js';

const SRGB_ID = 'srgb';

// ---- models ----------------------------------------------------------------------------------------------------------

const models = new Map(); // profile id -> { kind: 'matrix' | 'gray' | 'lcms', matrix, curves }

/** How a profile converts: 'matrix' (RGB matrix/TRC), 'gray' (a Gray TRC) or 'lcms' (anything else). */
export function modelFor(profile) {
  const id = profile?.id ?? SRGB_ID;
  if (models.has(id)) return models.get(id);
  const bytes = profile?.bytes ?? builtinIcc(id) ?? (id === SRGB_ID ? builtinIcc(SRGB_ID) : null);
  const m = modelOf(parseIcc(bytes));
  let model;
  if (m?.space === 'rgb' && m.matrix && m.curves && invert3(m.matrix)) model = { kind: 'matrix', matrix: m.matrix, inverse: invert3(m.matrix), curves: m.curves };
  else if (m?.space === 'gray' && m.curves) model = { kind: 'gray', curves: [m.curves[0], m.curves[0], m.curves[0]] };
  else model = { kind: 'lcms', space: m?.space ?? null };
  models.set(id, model);
  return model;
}

/** Drops a cached model (a profile removed from the library). */
export const forgetModel = (id) => models.delete(id);

const SRGB_PROFILE = { id: SRGB_ID, bytes: null };

/** Two profiles that convert nothing: the same id, or the same well-known space (an sRGB variant and sRGB). */
export function sameSpace(a, b) {
  const ia = a?.id ?? SRGB_ID, ib = b?.id ?? SRGB_ID;
  if (ia === ib) return true;
  const wa = a ? a.wellKnown : 'srgb', wb = b ? b.wellKnown : 'srgb';
  return !!wa && wa === wb;
}

// ---- 8-bit kernels ---------------------------------------------------------------------------------------------------

const N = 16384; // linear steps of the output tables

// Plain Uint8Array views: V8 stores into a Uint8ClampedArray (ImageData) more slowly, and every value written here is
// already 0..255
const bytesOf = (a) => (a instanceof Uint8Array ? a : new Uint8Array(a.buffer, a.byteOffset, a.length));

function linTable(curve) {
  // float, scaled to the output table's steps: the matrix products then stay doubles in registers (integer products
  // of this size leave V8's small-integer range, which made a fixed-point kernel half as fast)
  const t = new Float32Array(256);
  for (let v = 0; v < 256; v++) t[v] = evalCurve(curve, v / 255) * N;
  return t;
}
function outTable(curve) {
  const t = new Uint8Array(N + 1);
  for (let i = 0; i <= N; i++) t[i] = Math.round(invertCurve(curve, i / N) * 255);
  return t;
}
const mul3x3 = (a, b) => {
  const o = new Array(9);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) o[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
  return o;
};

/** RGB matrix/TRC → RGB matrix/TRC on RGBA8 (alpha copied). */
function matrixKernel(A, B) {
  const [lr, lg, lb] = A.curves.map(linTable);
  const [or, og, ob] = B.curves.map(outTable);
  const [m0, m1, m2, m3, m4, m5, m6, m7, m8] = mul3x3(B.inverse, A.matrix);
  return (srcIn, dstIn, n) => {
    const src = bytesOf(srcIn), dst = bytesOf(dstIn);
    const e = n * 4;
    for (let o = 0; o < e; o += 4) {
      const r = lr[src[o]], g = lg[src[o + 1]], b = lb[src[o + 2]];
      const x = (m0 * r + m1 * g + m2 * b + 0.5) | 0;
      const y = (m3 * r + m4 * g + m5 * b + 0.5) | 0;
      const z = (m6 * r + m7 * g + m8 * b + 0.5) | 0;
      dst[o] = or[x < 0 ? 0 : x > N ? N : x];
      dst[o + 1] = og[y < 0 ? 0 : y > N ? N : y];
      dst[o + 2] = ob[z < 0 ? 0 : z > N ? N : z];
      dst[o + 3] = src[o + 3];
    }
  };
}

/** A table per channel (Gray profiles on either side: each channel is a tone). */
function channelKernel(A, B) {
  const tables = [0, 1, 2].map((c) => {
    const t = new Uint8Array(256);
    for (let v = 0; v < 256; v++) t[v] = Math.round(invertCurve(B.curves[c], evalCurve(A.curves[c], v / 255)) * 255);
    return t;
  });
  const [tr, tg, tb] = tables;
  return (srcIn, dstIn, n) => {
    const src = bytesOf(srcIn), dst = bytesOf(dstIn);
    const e = n * 4;
    for (let o = 0; o < e; o += 4) {
      dst[o] = tr[src[o]];
      dst[o + 1] = tg[src[o + 1]];
      dst[o + 2] = tb[src[o + 2]];
      dst[o + 3] = src[o + 3];
    }
  };
}

// ---- float maths (single colours, 16-bit and float pixels without the wasm) ------------------------------------------

/** Linear light (the profile's own RGB primaries, or tones) of numbers 0..1. */
const toLinear = (model, v) => [0, 1, 2].map((c) => evalCurve(model.curves[c], v[c]));
const fromLinear = (model, l) => [0, 1, 2].map((c) => invertCurve(model.curves[c], l[c]));
const apply3 = (m, v) => [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];

let srgbMatrixModel = null;
const srgbModel = () => (srgbMatrixModel ??= modelFor(SRGB_PROFILE));

/** D50 XYZ of numbers 0..1 in a JS model (a Gray profile's tones read through sRGB's primaries: neutral stays neutral). */
function modelToXyz(model, v) {
  const lin = toLinear(model, v);
  return apply3(model.kind === 'matrix' ? model.matrix : srgbModel().matrix, lin);
}
function modelFromXyz(model, xyz) {
  const lin = apply3(model.kind === 'matrix' ? model.inverse : srgbModel().inverse, xyz);
  return fromLinear(model, lin.map((l) => Math.min(1, Math.max(0, l))));
}

function floatConvert(A, B, v) {
  if (A.kind === 'gray' || B.kind === 'gray') return fromLinear(B, toLinear(A, v).map((l) => Math.min(1, Math.max(0, l))));
  return modelFromXyz(B, modelToXyz(A, v));
}

// ---- transforms --------------------------------------------------------------------------------------------------------

const IDENTITY = Object.freeze({
  identity: true,
  apply(src, dst, n) {
    if (src !== dst) dst.set(src.subarray(0, n * 4));
  },
});

const FORMAT_INFO = {
  rgba8: { type: TYPE.RGBA_8, bytes: 4, max: 255 },
  rgba16: { type: TYPE.RGBA_16, bytes: 8, max: 65535 },
  rgbaf32: { type: TYPE.RGBA_FLT, bytes: 16, max: 1 },
};

const cache = new Map(); // key -> transform object

/**
 * engine.transform (S6.1): { identity, apply(src, dst, n), kind } between two ColorProfiles (null: sRGB, the working
 * space in 0.5). `format`: 'rgba8' (Uint8Array / Uint8ClampedArray, the default), 'rgba16' (Uint16Array), 'rgbaf32'
 * (Float32Array, 0..1). Alpha is copied. A pair nothing can convert (a CMYK profile, LittleCMS missing for a LUT
 * profile) is the identity, with `kind: 'unsupported'`.
 */
export function makeTransform(from, to, { intent = 'perceptual', bpc = true, format = 'rgba8' } = {}) {
  if (sameSpace(from, to)) return IDENTITY;
  const info = FORMAT_INFO[format] ?? FORMAT_INFO.rgba8;
  const key = `${from?.id ?? SRGB_ID}>${to?.id ?? SRGB_ID}|${intent}|${bpc ? 1 : 0}|${format}`;
  if (cache.has(key)) return cache.get(key);
  const A = modelFor(from), B = modelFor(to);
  const js = A.kind !== 'lcms' && B.kind !== 'lcms' && intent !== 'absolute' && intent !== 'absolute-colorimetric';
  let t = null;
  if (js && format === 'rgba8') {
    // perceptual and saturation equal relative colorimetric for matrix/TRC and Gray TRC profiles, and black point
    // compensation changes nothing between profiles whose black is 0 (LittleCMS gives the same numbers)
    const kernel = A.kind === 'matrix' && B.kind === 'matrix' ? matrixKernel(A, B) : channelKernel(A, B);
    t = { identity: false, kind: 'js', apply: kernel };
  } else if (lcms()) {
    const handle = lcmsTransform(from, to, { intent, bpc, inFmt: info.type, outFmt: info.type });
    if (handle) t = { identity: false, kind: 'lcms', apply: (src, dst, n) => runTransform(handle, src, dst, n, info.bytes, info.bytes) };
  }
  if (!t && js) {
    // 16-bit and float pixels before the wasm is there: exact float maths per pixel (slow, and rare: 0.5 converts
    // 8-bit composites)
    const max = info.max;
    const round = format !== 'rgbaf32';
    t = {
      identity: false,
      kind: 'js-float',
      apply(src, dst, n) {
        for (let i = 0, o = 0; i < n; i++, o += 4) {
          const out = floatConvert(A, B, [src[o] / max, src[o + 1] / max, src[o + 2] / max]);
          for (let c = 0; c < 3; c++) dst[o + c] = round ? Math.round(out[c] * max) : out[c];
          dst[o + 3] = src[o + 3];
        }
      },
    };
  }
  if (!t) t = { ...IDENTITY, kind: 'unsupported' };
  cache.set(key, t);
  return t;
}

/** Drops the cached transforms of a profile. */
export function forgetTransforms(id) {
  for (const key of [...cache.keys()]) if (key.startsWith(`${id}>`) || key.includes(`>${id}|`)) cache.delete(key);
  forgetModel(id);
}

// ---- single colours ----------------------------------------------------------------------------------------------------

/** RGB numbers 0..255 from one profile into another (relative colorimetric, as colour pickers convert). */
export function convertRgb(rgb, from, to, { intent = 'relative' } = {}) {
  const src = Uint8ClampedArray.of(rgb[0], rgb[1], rgb[2], 255);
  const out = new Uint8ClampedArray(4);
  makeTransform(from, to, { intent, bpc: true }).apply(src, out, 1);
  return [out[0], out[1], out[2]];
}

/** Lab (D50) of RGB numbers 0..255 in `profile`. */
export function rgbToLab(rgb, profile) {
  const model = modelFor(profile);
  if (model.kind !== 'lcms') return xyzToLab(modelToXyz(model, rgb.map((v) => v / 255)));
  const L = lcms();
  const t = L ? lcmsTransform(profile, { id: 'lab-d50' }, { intent: 'relative', bpc: false, inFmt: TYPE.RGB_8, outFmt: TYPE.LAB_DBL }) : 0;
  if (!t) return null;
  const out = new Float64Array(3);
  runTransform(t, Uint8Array.of(rgb[0], rgb[1], rgb[2]), out, 1, 3, 24);
  return [out[0], out[1], out[2]];
}

/** RGB numbers 0..255 (unrounded) in `profile` for a Lab (D50) colour, clipped to the profile's gamut. */
export function labToRgb(lab, profile) {
  const model = modelFor(profile);
  if (model.kind !== 'lcms') return modelFromXyz(model, labToXyz(lab)).map((v) => v * 255);
  const L = lcms();
  const t = L ? lcmsTransform({ id: 'lab-d50' }, profile, { intent: 'relative', bpc: false, inFmt: TYPE.LAB_DBL, outFmt: TYPE.RGB_DBL }) : 0;
  if (!t) return null;
  const out = new Float64Array(3);
  runTransform(t, Float64Array.from(lab), out, 1, 24, 24);
  return [out[0] * 255, out[1] * 255, out[2] * 255];
}

/**
 * Whether RGB numbers of `from` fall inside the gamut of `to` (a colour that needs `color(display-p3 …)` falls outside
 * sRGB); null when a profile is neither matrix/TRC nor Gray.
 */
export function inGamut(rgb, from, to) {
  const A = modelFor(from), B = modelFor(to);
  if (A.kind === 'lcms' || B.kind === 'lcms') return null;
  if (A.kind === 'gray' || B.kind === 'gray') return true;
  const lin = apply3(B.inverse, modelToXyz(A, rgb.map((v) => v / 255)));
  return lin.every((l) => l > -0.0005 && l < 1.0005);
}
