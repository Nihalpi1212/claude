// PSD value conversions shared by every mapper (ARCHITECTURE.md "0.5 features", S4.1), skeleton file, frozen: no
// package edits it. Colours (through the colour pipeline's fromLab, so a Lab colour no longer turns black or white),
// blend modes, ag-psd gradients ↔ Pigment's GradientDef and ag-psd patterns ↔ pixels or a PatternRef. These were
// 0.4's private helpers of lib/io.js. Node-safe: canvases are made only when a function that returns one is called.
import { parseColor } from '../../../shared/pixels/color.js';
import { isGradientV2, normalizeGradient } from '../../../shared/pixels/gradient-model.js';
import { fromLab } from '../color/pipeline.js';

// ---- colours ---------------------------------------------------------------------------------------------------

const hex2 = (v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0');

export function hsbToRgb(h, s, v) {
  const i = Math.floor(h * 6), f = h * 6 - i, p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
  return [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][((i % 6) + 6) % 6];
}

export function hsbHex(h, s, b) {
  const [r, g, bl] = hsbToRgb(h / 360, s / 100, b / 100);
  const hx = (v) => Math.round(v * 255).toString(16).padStart(2, '0');
  return `#${hx(r)}${hx(g)}${hx(bl)}`;
}

/**
 * '#rrggbb' for an ag-psd colour (RGB, CMYK with 0.3's naive model, Grayscale, HSB, Lab). `profile` is the document's
 * (Lab colours go through fromLab into it; null: the working space). Unknown or missing: `fallback`.
 */
export function rgbFromPsd(c, fallback = '#000000', profile = null) {
  if (!c) return fallback;
  if ('r' in c) return `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`;
  if ('c' in c && 'k' in c) return `#${hex2(255 * (1 - c.c / 100) * (1 - c.k / 100))}${hex2(255 * (1 - c.m / 100) * (1 - c.k / 100))}${hex2(255 * (1 - c.y / 100) * (1 - c.k / 100))}`;
  if ('k' in c) return `#${hex2(255 * (1 - c.k / 100)).repeat(3)}`;
  if ('h' in c) return hsbHex(c.h, c.s, c.b);
  if ('l' in c && 'a' in c) {
    const [r, g, b] = fromLab([c.l, c.a, c.b ?? 0], profile);
    return `#${hex2(r)}${hex2(g)}${hex2(b)}`;
  }
  return fallback;
}

/** ag-psd's { r, g, b } for '#rrggbb'. */
export const psdColor = (hex) => {
  const [r, g, b] = parseColor(hex);
  return { r, g, b };
};

// ---- blend modes -----------------------------------------------------------------------------------------------

export const PSD_TO_BLEND = Object.freeze({ 'pass through': 'pass-through', 'linear height': 'normal', height: 'normal', subtraction: 'subtract' });
export const BLEND_TO_PSD = Object.freeze({ 'pass-through': 'pass through' });
/** Pigment's blend mode id for an ag-psd blend mode name. */
export const psdBlend = (m) => PSD_TO_BLEND[m] ?? (m ? m.replace(/ /g, '-') : 'normal');
/** ag-psd's blend mode name for a Pigment blend mode id. */
export const toPsdBlend = (m) => BLEND_TO_PSD[m] ?? m.replace(/-/g, ' ');

// ---- gradients -------------------------------------------------------------------------------------------------

// The Gradient Map's interpolation method in a grdm block (version 3): Photoshop's 4-character codes. The vendored
// ag-psd reads and writes them as `methodCode` (scripts/vendor-entries/ag-psd-grdm.js); a block without one (version
// 1: Photoshop before CC, older Pigment) is Classic. Photoshop's Stripes method has no code here: it is written as
// Classic, the nearest.
export const GRDM_CODES = Object.freeze({ classic: 'Gcls', perceptual: 'Perc', linear: 'Lnr ', smooth: 'Smoo' });
export const GRDM_METHODS = Object.freeze(Object.fromEntries(Object.entries(GRDM_CODES).map(([k, v]) => [v, k])));

// ag-psd writes each location times the smoothness ('Intr' = smoothness x 4096), but Photoshop reads locations out of
// 4096 whatever the smoothness, and smoothness 0 would write every location as 0 (read back as 0 / 0). So the
// smoothness is kept at 1 / 4096 or more and the locations are divided by it first: the file holds location x 4096.
export const psdGradientStops = (smoothness, colorStops, opacityStops) => {
  const sm = Math.max(1, Math.round(Math.max(0, Math.min(1, smoothness ?? 1)) * 4096)) / 4096;
  const scale = (s) => ({ ...s, location: s.location / sm });
  return { smoothness: sm, colorStops: colorStops.map(scale), opacityStops: opacityStops.map(scale) };
};

/**
 * ag-psd gradient fields (as the Gradient Map adjustment holds them: name, gradientType, methodCode, reverse, dither,
 * smoothness, colorStops, opacityStops) for a Pigment gradient: a v2 GradientDef (G.1) or 0.3's `{ stops, reverse }`.
 */
export function gradientToPsd(p = {}) {
  // a v2 def is normalised: its colour stops with their midpoints and its opacity stops, and its method (as
  // Photoshop's code). 0.3 stops are linear, which is Classic at smoothness 0
  if (isGradientV2(p)) {
    const g = normalizeGradient(p);
    return { name: 'Gradient', gradientType: 'solid', methodCode: GRDM_CODES[g.interpolation] ?? GRDM_CODES.classic, reverse: !!p.reverse, dither: !!p.dither, ...psdGradientStops(g.smoothness, g.stops.map((s) => ({ location: s.pos, midpoint: s.mid, color: psdColor(s.color) })), g.opacityStops.map((s) => ({ location: s.pos, midpoint: s.mid, opacity: s.opacity }))) };
  }
  const stops = (p.stops?.length ? p.stops : [{ offset: 0, color: '#000000' }, { offset: 1, color: '#ffffff' }]).map((s) => ({ location: s.offset ?? s.pos ?? 0, midpoint: 0.5, color: psdColor(s.color) }));
  return { name: 'Gradient', gradientType: 'solid', methodCode: GRDM_CODES.classic, reverse: !!p.reverse, dither: false, ...psdGradientStops(0, stops, [{ location: 0, midpoint: 0.5, opacity: 1 }, { location: 1, midpoint: 0.5, opacity: 1 }]) };
}

/** A Pigment gradient (a v2 def when it needs one, else 0.3's `{ stops, reverse, dither }`) from ag-psd gradient fields. */
export function gradientFromPsd(a = {}, { profile = null } = {}) {
  // ag-psd divides the locations by the smoothness ('Intr', 0..4096), Photoshop stores them out of 4096: multiply it
  // back. Smoothness 0 leaves nothing to multiply (0 / 0): the stops are then spread evenly
  const sm = Number.isFinite(a.smoothness) ? Math.max(0, Math.min(1, a.smoothness)) : 1;
  const loc = (list) => list.map((s, i) => (sm > 0 && Number.isFinite(s.location) ? Math.max(0, Math.min(1, s.location * sm)) : list.length > 1 ? i / (list.length - 1) : 0));
  const colorStops = a.colorStops ?? [], opacityStops = a.opacityStops ?? [];
  const cpos = loc(colorStops), opos = loc(opacityStops);
  const mid = (s) => Math.max(0.05, Math.min(0.95, Number.isFinite(s.midpoint) ? s.midpoint : 0.5));
  const smoothness = sm * 4096 <= 1 ? 0 : sm; // gradientToPsd writes smoothness 0 as 1 / 4096
  // only the raw code is trusted (`method` of an ag-psd without the fix reads every code as Perceptual); none is Classic
  const interpolation = GRDM_METHODS[a.methodCode] ?? 'classic';
  const plain = interpolation === 'classic' && smoothness === 0 && colorStops.every((s, i) => i === 0 || mid(s) === 0.5) && opacityStops.every((s) => (s.opacity ?? 1) >= 1);
  if (colorStops.length >= 2 && !plain) {
    // midpoints, transparency, smoothness or another method: a v2 def (G.1) keeps them
    return { gradientVersion: 2, type: 'solid', interpolation, smoothness, stops: colorStops.map((s, i) => ({ pos: cpos[i], mid: mid(s), color: rgbFromPsd(s.color, '#000000', profile) })), opacityStops: opacityStops.length ? opacityStops.map((s, i) => ({ pos: opos[i], mid: mid(s), opacity: Math.max(0, Math.min(1, s.opacity ?? 1)) })) : [{ pos: 0, mid: 0.5, opacity: 1 }, { pos: 1, mid: 0.5, opacity: 1 }], reverse: !!a.reverse, dither: !!a.dither };
  }
  const stops = colorStops.map((s, i) => ({ offset: cpos[i], color: rgbFromPsd(s.color, '#000000', profile) }));
  return { stops: stops.length >= 2 ? stops : [{ offset: 0, color: '#000000' }, { offset: 1, color: '#ffffff' }], reverse: !!a.reverse, dither: !!a.dither };
}

// ---- patterns --------------------------------------------------------------------------------------------------

/** Straight RGBA pixels of an ag-psd PatternInfo: `{ name, id, width, height, data: Uint8ClampedArray }` or null. */
export function patternFromPsd(info) {
  const w = info?.bounds?.w ?? 0, h = info?.bounds?.h ?? 0;
  if (!(w > 0 && h > 0) || !info.data || info.data.length < w * h * 4) return null;
  return { name: info.name ?? 'Pattern', id: info.id ?? null, width: w, height: h, data: new Uint8ClampedArray(info.data.buffer, info.data.byteOffset, w * h * 4) };
}

/** A canvas of a pattern's pixels (renderer only: needs a DOM canvas). */
export function patternCanvas(info) {
  const p = patternFromPsd(info);
  if (!p || typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = p.width;
  c.height = p.height;
  c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(p.data), p.width, p.height), 0, 0);
  return c;
}

/**
 * A PatternRef (L.6: `{ presetId, name, dataUrl }`) for an ag-psd PatternInfo, with the pixels as a data URL (the
 * pattern travels with the layer), or null without pixels. `presetId` names a `patterns` preset when the caller found
 * one with the same pixels (ctx.patterns), else null.
 */
export function patternRefFromPsd(info, { presetId = null } = {}) {
  const c = patternCanvas(info);
  if (!c) return null;
  return { presetId, name: info.name ?? 'Pattern', dataUrl: c.toDataURL('image/png') };
}

/** An ag-psd PatternInfo for pixels (a canvas, or `{ width, height, data }` RGBA): `{ name, id, x, y, bounds, data }`. */
export function patternToPsd({ name = 'Pattern', id = null, canvas = null, width, height, data } = {}) {
  let w = width, h = height, px = data;
  if (canvas) {
    w = canvas.width;
    h = canvas.height;
    px = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  }
  if (!(w > 0 && h > 0) || !px) return null;
  return { name, id: id ?? patternId(px, w, h), x: 0, y: 0, bounds: { x: 0, y: 0, w, h }, data: new Uint8Array(px.buffer, px.byteOffset, w * h * 4) };
}

/** A stable id for pattern pixels (Photoshop's ids are UUIDs; any unique string is read back): FNV-1a of the bytes. */
function patternId(px, w, h) {
  let a = 0x811c9dc5 ^ w, b = 0x01000193 ^ h;
  for (let i = 0; i < px.length; i++) {
    a = Math.imul(a ^ px[i], 0x01000193) >>> 0;
    b = Math.imul(b ^ a, 0x85ebca6b) >>> 0;
  }
  return `pigment-${a.toString(16).padStart(8, '0')}${b.toString(16).padStart(8, '0')}`;
}
