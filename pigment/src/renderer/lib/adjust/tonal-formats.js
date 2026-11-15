// Photoshop's Levels (.alv) and Curves (.acv) preset files, and the built-in presets of the tonal adjustments
// (adjust-tonal, ARCHITECTURE.md "0.4 features", package 7, C). Pure: no DOM, unit-tested in Node.
//
// .acv (Adobe "Photoshop File Formats", Curves): big-endian int16 throughout: version (1 or 4), the number of curves,
// then per curve the number of points (2..19) and the points as (output, input) pairs, 0..255. The curves are the
// composite then the channels of the document mode (RGB: composite, red, green, blue; CMYK: composite, C, M, Y, K).
// We write version 1 (every Photoshop reads it); version 4 files are read the same way, trailing data ignored.
//
// .alv (Levels): int16 version (2), then 29 records of five int16 (input floor, input ceiling, output floor, output
// ceiling, gamma x 100): the composite then the channels; unused records are the identity. Some versions append an
// extended block after the 29 records; it is ignored.
//
// A file does not say which mode it was made in: RGB is assumed (the composite and the first three channels); an
// editor in another mode remaps (adjust-tonal.js remapTonalSpace). A Lab set (no composite) is written with an
// identity composite first.

import { DEFAULT_LEVELS, TONAL_SPACES, tonalSpace, isTable, normalisePoints, pointsFromTable, curveLut, isIdentityLut } from '../../../shared/pixels/adjust-tonal.js';

const clampInt = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(Number.isFinite(v) ? v : lo)));

/** The keys a file's records map to, in order, for params in `space`. Lab has no composite: record 0 is unused. */
function recordKeys(space) {
  const s = TONAL_SPACES[space] ?? TONAL_SPACES.rgb;
  return [s.composite, ...s.channels];
}

// ---- .acv ------------------------------------------------------------------------------------------------------

const IDENTITY_POINTS = [[0, 0], [255, 255]];

/** Curves params -> .acv bytes. Drawn channels are turned into points (Photoshop's files hold points only). */
export function writeAcv(params) {
  const space = tonalSpace(params);
  const keys = recordKeys(space);
  const curves = keys.map((k) => {
    const ch = k ? params?.[k] : null;
    let pts = isTable(ch) ? pointsFromTable(ch, 17) : Array.isArray(ch) ? normalisePoints(ch) : IDENTITY_POINTS;
    if (pts.length < 2) pts = IDENTITY_POINTS;
    if (pts.length > 19) pts = pointsFromTable({ table: Array.from(curveLut(pts)) }, 19);
    return pts;
  });
  const size = 4 + curves.reduce((n, c) => n + 2 + c.length * 4, 0);
  const out = new DataView(new ArrayBuffer(size));
  let o = 0;
  out.setInt16(o, 1);
  out.setInt16(o + 2, curves.length);
  o += 4;
  for (const pts of curves) {
    out.setInt16(o, pts.length);
    o += 2;
    for (const [x, y] of pts) {
      out.setInt16(o, clampInt(y, 0, 255));
      out.setInt16(o + 2, clampInt(x, 0, 255));
      o += 4;
    }
  }
  return new Uint8Array(out.buffer);
}

/**
 * .acv bytes -> { params (RGB space Curves params), report: string[] }. Throws on a file that is not a Curves file.
 * Identity channels read as null (the composite as the straight line).
 */
export function readAcv(bytes, { space = 'rgb' } = {}) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b.byteLength < 4) throw new Error('Not a Curves file');
  const version = view.getInt16(0), count = view.getInt16(2);
  if ((version !== 1 && version !== 4) || count < 1 || count > 32) throw new Error('Not a Curves file');
  let o = 4;
  const curves = [];
  for (let i = 0; i < count; i++) {
    if (o + 2 > b.byteLength) throw new Error('The Curves file is cut short');
    const n = view.getInt16(o);
    o += 2;
    if (n < 0 || n > 64 || o + n * 4 > b.byteLength) throw new Error('The Curves file is damaged');
    const pts = [];
    for (let k = 0; k < n; k++) {
      pts.push([clampInt(view.getInt16(o + 2), 0, 255), clampInt(view.getInt16(o), 0, 255)]);
      o += 4;
    }
    curves.push(normalisePoints(pts));
  }
  const keys = recordKeys(space);
  const report = [];
  const params = { space };
  keys.forEach((k, i) => {
    if (!k) return;
    const pts = curves[i];
    const identity = !pts || pts.length < 2 || isIdentityLut(curveLut(pts));
    params[k] = identity ? (k === TONAL_SPACES[space].composite ? [[0, 0], [255, 255]] : null) : pts;
  });
  if (curves.length > keys.length) report.push(`${curves.length - keys.length} more channel curve${curves.length - keys.length === 1 ? '' : 's'} skipped`);
  return { params, report };
}

// ---- .alv ------------------------------------------------------------------------------------------------------

const ALV_RECORDS = 29;

/** Levels params -> .alv bytes (version 2, 29 records). */
export function writeAlv(params) {
  const space = tonalSpace(params);
  const keys = recordKeys(space);
  const out = new DataView(new ArrayBuffer(2 + ALV_RECORDS * 10));
  out.setInt16(0, 2);
  for (let r = 0; r < ALV_RECORDS; r++) {
    const k = keys[r];
    const l = { ...DEFAULT_LEVELS, ...(k && params?.[k] ? params[k] : {}) };
    // per-channel tables count only when perChannel is not false (0.3's flag)
    const use = !(space === 'rgb' && params?.perChannel === false && r > 0);
    const v = use ? l : DEFAULT_LEVELS;
    const o = 2 + r * 10;
    const inB = clampInt(v.inBlack, 0, 253);
    out.setInt16(o, inB);
    out.setInt16(o + 2, clampInt(v.inWhite, inB + 2, 255));
    out.setInt16(o + 4, clampInt(v.outBlack, 0, 255));
    out.setInt16(o + 6, clampInt(v.outWhite, 0, 255));
    out.setInt16(o + 8, clampInt(v.gamma * 100, 10, 999));
  }
  return new Uint8Array(out.buffer);
}

/** .alv bytes -> { params (RGB space Levels params), report }. Throws on a file that is not a Levels file. */
export function readAlv(bytes, { space = 'rgb' } = {}) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b.byteLength < 2 + 10) throw new Error('Not a Levels file');
  const version = view.getInt16(0);
  if (version !== 2 && version !== 1) throw new Error('Not a Levels file');
  const n = Math.min(ALV_RECORDS, Math.floor((b.byteLength - 2) / 10));
  const records = [];
  for (let r = 0; r < n; r++) {
    const o = 2 + r * 10;
    const inBlack = view.getInt16(o), inWhite = view.getInt16(o + 2), outBlack = view.getInt16(o + 4), outWhite = view.getInt16(o + 6), g = view.getInt16(o + 8);
    if (inBlack < 0 || inBlack > 255 || inWhite < 0 || inWhite > 255 || outBlack < 0 || outBlack > 255 || outWhite < 0 || outWhite > 255 || g < 1 || g > 999) throw new Error('The Levels file is damaged');
    records.push({ inBlack, inWhite: Math.max(inWhite, inBlack + 1), gamma: g / 100, outBlack, outWhite });
  }
  const isId = (l) => l.inBlack === 0 && l.inWhite === 255 && l.outBlack === 0 && l.outWhite === 255 && l.gamma === 1;
  const keys = recordKeys(space);
  const params = { space };
  if (space === 'rgb') params.perChannel = true;
  keys.forEach((k, i) => {
    if (!k) return;
    const l = records[i];
    params[k] = !l || isId(l) ? (k === TONAL_SPACES[space].composite ? { ...DEFAULT_LEVELS } : null) : l;
  });
  const report = [];
  const extra = records.slice(keys.length).filter((l) => !isId(l)).length;
  if (extra) report.push(`${extra} more channel setting${extra === 1 ? '' : 's'} skipped`);
  return { params, report };
}

// ---- built-in presets (Photoshop's lists, values approximated) -------------------------------------------------

const L = (o) => ({ ...DEFAULT_LEVELS, ...o });
const levels = (rgb, chans = {}) => ({ space: 'rgb', perChannel: true, rgb: L(rgb), r: chans.r ? L(chans.r) : null, g: chans.g ? L(chans.g) : null, b: chans.b ? L(chans.b) : null });
const curves = (rgb, chans = {}) => ({ space: 'rgb', rgb, r: chans.r ?? null, g: chans.g ?? null, b: chans.b ?? null });

export const TONAL_BUILTINS = Object.freeze({
  levels: [
    { id: 'darker', name: 'Darker', data: levels({ inBlack: 15, gamma: 0.85 }) },
    { id: 'increase-contrast-1', name: 'Increase Contrast 1', data: levels({ inBlack: 10, inWhite: 245 }) },
    { id: 'increase-contrast-2', name: 'Increase Contrast 2', data: levels({ inBlack: 20, inWhite: 235 }) },
    { id: 'increase-contrast-3', name: 'Increase Contrast 3', data: levels({ inBlack: 30, inWhite: 225 }) },
    { id: 'lighten-shadows', name: 'Lighten Shadows', data: levels({ gamma: 1.25, outBlack: 25 }) },
    { id: 'lighter', name: 'Lighter', data: levels({ inWhite: 230, gamma: 1.15 }) },
    { id: 'midtones-brighter', name: 'Midtones Brighter', data: levels({ gamma: 1.4 }) },
    { id: 'midtones-darker', name: 'Midtones Darker', data: levels({ gamma: 0.7 }) },
  ],
  curves: [
    { id: 'color-negative', name: 'Color Negative (RGB)', data: curves([[0, 255], [255, 0]], { r: [[0, 0], [255, 235]], g: [[0, 10], [255, 245]], b: [[0, 40], [255, 255]] }) },
    { id: 'cross-process', name: 'Cross Process (RGB)', data: curves([[0, 0], [255, 255]], { r: [[0, 0], [64, 40], [192, 222], [255, 255]], g: [[0, 0], [64, 52], [192, 210], [255, 255]], b: [[0, 40], [255, 210]] }) },
    { id: 'darker', name: 'Darker (RGB)', data: curves([[0, 0], [128, 96], [255, 255]]) },
    { id: 'increase-contrast', name: 'Increase Contrast (RGB)', data: curves([[0, 0], [64, 54], [192, 202], [255, 255]]) },
    { id: 'lighter', name: 'Lighter (RGB)', data: curves([[0, 0], [128, 160], [255, 255]]) },
    { id: 'linear-contrast', name: 'Linear Contrast (RGB)', data: curves([[0, 0], [48, 32], [208, 224], [255, 255]]) },
    { id: 'contrast', name: 'Medium Contrast (RGB)', data: curves([[0, 0], [64, 48], [192, 208], [255, 255]]) },
    { id: 'negative', name: 'Negative (RGB)', data: curves([[0, 255], [255, 0]]) },
    { id: 'strong-contrast', name: 'Strong Contrast (RGB)', data: curves([[0, 0], [64, 32], [192, 224], [255, 255]]) },
  ],
  exposure: [
    { id: 'minus-2', name: 'Minus 2.0', data: { exposure: -2, offset: 0, gamma: 1 } },
    { id: 'minus-1', name: 'Minus 1.0', data: { exposure: -1, offset: 0, gamma: 1 } },
    { id: 'plus-1', name: 'Plus 1.0', data: { exposure: 1, offset: 0, gamma: 1 } },
    { id: 'plus-2', name: 'Plus 2.0', data: { exposure: 2, offset: 0, gamma: 1 } },
  ],
  'brightness-contrast': [
    { id: 'brighter', name: 'Brighter', data: { brightness: 30, contrast: 0, legacy: false } },
    { id: 'darker', name: 'Darker', data: { brightness: -30, contrast: 0, legacy: false } },
    { id: 'more-contrast', name: 'More Contrast', data: { brightness: 0, contrast: 30, legacy: false } },
    { id: 'less-contrast', name: 'Less Contrast', data: { brightness: 0, contrast: -30, legacy: false } },
  ],
  threshold: [
    { id: 'dark', name: 'Dark (96)', data: { level: 96 } },
    { id: 'middle', name: 'Middle (128)', data: { level: 128 } },
    { id: 'light', name: 'Light (160)', data: { level: 160 } },
  ],
});

// ---- normalising stored data ------------------------------------------------------------------------------------

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const finite = (v) => typeof v === 'number' && Number.isFinite(v);

/** The `normalize` of the tonal preset kinds: keeps well-formed params, drops anything else (null). */
export function normalizeTonalPreset(kind, data) {
  if (!isObject(data)) return null;
  if (kind === 'levels' || kind === 'curves') {
    const space = tonalSpace(data);
    const keys = recordKeys(space).filter(Boolean);
    if (!keys.some((k) => data[k] != null)) return null;
    const out = { ...data, space };
    for (const k of keys) {
      const ch = data[k];
      if (ch == null) out[k] = null;
      else if (kind === 'levels' && !isObject(ch)) return null;
      else if (kind === 'curves' && !(Array.isArray(ch) || isTable(ch))) return null;
    }
    return out;
  }
  if (kind === 'exposure') return finite(data.exposure) || finite(data.offset) || finite(data.gamma) ? data : null;
  if (kind === 'brightness-contrast') return finite(data.brightness) || finite(data.contrast) ? data : null;
  if (kind === 'threshold') return finite(data.level) ? data : null;
  return data;
}
