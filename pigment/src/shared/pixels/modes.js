// Image modes (see ARCHITECTURE.md "Image modes"): Bitmap, Grayscale, Duotone, Indexed Color, RGB,
// CMYK, Lab and Multichannel.
//
// A Pigment document always stores RGBA pixels. A mode is a promise about those pixels plus a way
// of looking at them:
//   grayscale     R = G = B (Rec. 601 luma of what was there)
//   bitmap        only black and white
//   duotone       grey pixels; the composite maps grey through the ink curves (duotoneLut)
//   indexed       only colours of the document's colour table
//   rgb/cmyk/lab  unconstrained; CMYK and Lab channels are derived planes (channelPlanes)
//   multichannel  the pixels of the mode it came from, shown through the spot channels that remain
// convertPixels() takes pixels from one mode to another, constrainImage()/constrainColor() keep
// edits inside a mode, renderMode() is what the compositor shows, channelPlanes() feeds the
// Channels panel. All of it is pure (ImageDataLike in, typed arrays out) and follows the
// conventions of filters.js: `rect` limits writes only, straight alpha, plain loops.
import { rgbToCmyk, cmykToRgb } from './color.js';
import { curveLut } from './adjust.js';
import { quantize, createMapper, indicesToImage, BAYER8 } from './quantize.js';

const ch = (id, name) => Object.freeze({ id, name });

/**
 * The eight modes: bit depths Photoshop offers for each, the name of the composite channel (null when
 * the mode has a single channel) and its colour channels. Multichannel has no fixed list: its channels
 * are the document's saved (spot) channels.
 */
export const MODES = Object.freeze({
  bitmap: Object.freeze({ id: 'bitmap', name: 'Bitmap', depths: [1], composite: null, channels: Object.freeze([ch('bitmap', 'Bitmap')]), constrained: true }),
  grayscale: Object.freeze({ id: 'grayscale', name: 'Grayscale', depths: [8, 16, 32], composite: null, channels: Object.freeze([ch('gray', 'Gray')]), constrained: true }),
  duotone: Object.freeze({ id: 'duotone', name: 'Duotone', depths: [8], composite: null, channels: Object.freeze([ch('duotone', 'Duotone')]), constrained: true }),
  indexed: Object.freeze({ id: 'indexed', name: 'Indexed Color', depths: [8], composite: null, channels: Object.freeze([ch('index', 'Index')]), constrained: true }),
  rgb: Object.freeze({ id: 'rgb', name: 'RGB Color', depths: [8, 16, 32], composite: 'RGB', channels: Object.freeze([ch('r', 'Red'), ch('g', 'Green'), ch('b', 'Blue')]), constrained: false }),
  cmyk: Object.freeze({ id: 'cmyk', name: 'CMYK Color', depths: [8, 16], composite: 'CMYK', channels: Object.freeze([ch('c', 'Cyan'), ch('m', 'Magenta'), ch('y', 'Yellow'), ch('k', 'Black')]), constrained: false }),
  lab: Object.freeze({ id: 'lab', name: 'Lab Color', depths: [8, 16], composite: 'Lab', channels: Object.freeze([ch('L', 'Lightness'), ch('A', 'a'), ch('B', 'b')]), constrained: false }),
  multichannel: Object.freeze({ id: 'multichannel', name: 'Multichannel', depths: [8, 16], composite: null, channels: Object.freeze([]), constrained: false }),
});
export const MODE_IDS = Object.freeze(Object.keys(MODES));

// The conversions Photoshop's Image > Mode menu offers directly. Bitmap is only reachable from (and
// only leaves to) Grayscale, Duotone needs Grayscale, Indexed Color needs RGB or Grayscale.
const DIRECT = {
  // listed with RGB first: when a pair needs two steps the detour keeps colour whenever it can
  bitmap: ['grayscale'],
  grayscale: ['rgb', 'bitmap', 'duotone', 'indexed', 'cmyk', 'lab', 'multichannel'],
  duotone: ['rgb', 'grayscale', 'cmyk', 'lab', 'multichannel'],
  indexed: ['rgb', 'grayscale', 'cmyk', 'lab'],
  rgb: ['grayscale', 'indexed', 'cmyk', 'lab', 'multichannel'],
  cmyk: ['rgb', 'grayscale', 'lab', 'multichannel'],
  lab: ['rgb', 'grayscale', 'cmyk', 'multichannel'],
  multichannel: ['rgb', 'grayscale', 'cmyk', 'lab'],
};

/** True when Photoshop converts `from` to `to` in one step. */
export const canConvert = (from, to) => from !== to && !!DIRECT[from]?.includes(to);

/**
 * The modes a conversion passes through, both ends included: [from, to] for a direct pair, otherwise
 * the shortest chain of direct conversions (RGB → Bitmap is RGB → Grayscale → Bitmap, as Photoshop
 * makes its users do by hand). Null for an unknown mode.
 */
export function conversionPath(from, to) {
  if (!MODES[from] || !MODES[to]) return null;
  if (from === to) return [from];
  const prev = new Map([[from, null]]);
  const queue = [from];
  while (queue.length) {
    const m = queue.shift();
    if (m === to) break;
    for (const next of DIRECT[m]) if (!prev.has(next)) {
      prev.set(next, m);
      queue.push(next);
    }
  }
  if (!prev.has(to)) return null;
  const path = [];
  for (let m = to; m; m = prev.get(m)) path.unshift(m);
  return path;
}

/** Modes whose conversion merges the document to one layer first (Photoshop asks "Flatten layers?"). */
export const FLATTENING_MODES = Object.freeze(['bitmap', 'indexed', 'multichannel']);

// ---- helpers ----------------------------------------------------------------------------------------------------

function bounds(img, rect) {
  if (!rect) return { x0: 0, y0: 0, x1: img.width, y1: img.height };
  const x0 = Math.max(0, Math.floor(rect.x)), y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(img.width, Math.ceil(rect.x + rect.width)), y1 = Math.min(img.height, Math.ceil(rect.y + rect.height));
  return { x0, y0, x1: Math.max(x0, x1), y1: Math.max(y0, y1) };
}

/** Rec. 601 luma of gamma-encoded values, rounded (red → 76, green → 150, blue → 29). */
export const luma = (r, g, b) => (r * 299 + g * 587 + b * 114 + 500) / 1000 | 0;

const LINEAR = (() => {
  const t = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const c = i / 255;
    t[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }
  return t;
})();
const encodeSrgb = (v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055) * 255;

function toRgb(c, fallback = [0, 0, 0]) {
  if (Array.isArray(c) || ArrayBuffer.isView(c)) return [c[0], c[1], c[2]];
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})/i.exec(String(c ?? '').trim());
  if (!m) return fallback;
  const h = m[1].length === 3 ? m[1].split('').map((x) => x + x).join('') : m[1];
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

// ---- grayscale -------------------------------------------------------------------------------------------------

/**
 * Makes pixels grey in place. method 'luma' (default): Rec. 601 luma of the gamma-encoded values, the
 * classic video weighting, cheap and exactly invertible for greys. method 'luminance': the relative
 * luminance (Rec. 709 weights in linear light) re-encoded with the sRGB curve, which is what a
 * colour-managed conversion such as Photoshop's (to a Gray Gamma profile) is close to: saturated
 * blues come out darker and greens lighter than with luma. Alpha is kept.
 */
export function toGrayscale(img, { method = 'luma' } = {}, rect = null) {
  const d = img.data, w = img.width;
  const { x0, y0, x1, y1 } = bounds(img, rect);
  const linear = method === 'luminance';
  for (let y = y0; y < y1; y++) for (let i = (y * w + x0) * 4, end = (y * w + x1) * 4; i < end; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    if (r === g && g === b) continue;
    const v = linear ? Math.round(encodeSrgb(0.2126 * LINEAR[r] + 0.7152 * LINEAR[g] + 0.0722 * LINEAR[b])) : (r * 299 + g * 587 + b * 114 + 500) / 1000 | 0;
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  return img;
}

// ---- bitmap -------------------------------------------------------------------------------------------------------

export const BITMAP_METHODS = Object.freeze(['50-threshold', 'pattern-dither', 'diffusion-dither', 'halftone-screen', 'custom-pattern']);
export const HALFTONE_SHAPES = Object.freeze(['round', 'diamond', 'ellipse', 'line', 'square', 'cross']);

/** Raw spot function of a halftone cell, u and v in [-0.5, 0.5): the smaller the value, the earlier the point turns black. */
function spotValue(shape, u, v) {
  const au = Math.abs(u), av = Math.abs(v);
  switch (shape) {
    case 'diamond': return au + av;
    case 'ellipse': return 1 - (0.62 * Math.cos(2 * Math.PI * u) + 0.38 * Math.cos(2 * Math.PI * v));
    case 'line': return av;
    case 'square': return Math.max(au, av);
    case 'cross': return Math.min(au, av);
    default: return 1 - (Math.cos(2 * Math.PI * u) + Math.cos(2 * Math.PI * v)) / 2; // round: the Euclidean dot
  }
}

const SPOT_TABLES = new Map();
/**
 * Threshold table of a spot function: maps its raw value to the fraction of the cell that turns black
 * before that point, so a tone of n% always covers n% of the cell whatever the dot shape.
 */
function spotTable(shape) {
  let t = SPOT_TABLES.get(shape);
  if (t) return t;
  const N = 96, values = new Float32Array(N * N);
  let min = Infinity, max = -Infinity;
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const s = spotValue(shape, (i + 0.5) / N - 0.5, (j + 0.5) / N - 0.5);
    values[j * N + i] = s;
    if (s < min) min = s;
    if (s > max) max = s;
  }
  const BINS = 2048, hist = new Uint32Array(BINS), scale = (BINS - 1) / (max - min || 1);
  for (let k = 0; k < values.length; k++) hist[Math.round((values[k] - min) * scale)]++;
  const cdf = new Float32Array(BINS);
  let acc = 0;
  for (let k = 0; k < BINS; k++) {
    // the middle of the bin's share, so thresholds stay strictly inside (0, 1)
    cdf[k] = (acc + hist[k] / 2) / values.length;
    acc += hist[k];
  }
  t = { min, scale, cdf, last: BINS - 1 };
  SPOT_TABLES.set(shape, t);
  return t;
}

/**
 * Reduces pixels to black and white in place.
 * @param {{ width, height, data }} img any RGBA image (its luma is thresholded)
 * @param {{ method?: string, frequency?: number, angle?: number, shape?: string, dpi?: number, pattern?: { width, height, data }, keepAlpha?: boolean }} [opts]
 *   method: '50-threshold' (grey ≥ 128 is white) | 'pattern-dither' (8×8 ordered) | 'diffusion-dither' (Floyd–Steinberg)
 *   | 'halftone-screen' (frequency in lines per inch at `dpi`, angle in degrees, dot shape) | 'custom-pattern' (a
 *   tile whose greys are the thresholds). keepAlpha leaves transparency alone; otherwise pixels are flattened
 *   onto white first, since a bitmap has no transparency.
 */
export function toBitmap(img, opts = {}, rect = null) {
  const { method = '50-threshold', keepAlpha = false } = opts;
  const d = img.data, w = img.width;
  const { x0, y0, x1, y1 } = bounds(img, rect);
  const rw = x1 - x0;
  if (rw <= 0 || y1 <= y0) return img;
  const grey = (i) => {
    const v = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
    if (keepAlpha) return v;
    const a = d[i + 3];
    return a === 255 ? v : (v * a + 255 * (255 - a)) / 255;
  };
  const put = (i, white) => {
    d[i] = d[i + 1] = d[i + 2] = white ? 255 : 0;
    if (!keepAlpha) d[i + 3] = 255;
  };
  if (method === 'diffusion-dither') {
    let cur = new Float32Array(rw + 2), next = new Float32Array(rw + 2);
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * w + x) * 4, e = x - x0 + 1;
        const v = grey(i) + cur[e];
        const white = v >= 127.5;
        const err = v - (white ? 255 : 0);
        put(i, white);
        cur[e + 1] += err * 0.4375;
        next[e - 1] += err * 0.1875;
        next[e] += err * 0.3125;
        next[e + 1] += err * 0.0625;
      }
      const t = cur;
      cur = next;
      next = t;
      next.fill(0);
    }
    return img;
  }
  if (method === 'halftone-screen') {
    const dpi = Math.max(1, Number(opts.dpi) || 72);
    const cell = Math.max(2, dpi / Math.max(1, Number(opts.frequency) || 15));
    const a = ((Number(opts.angle) || 0) * Math.PI) / 180;
    const cos = Math.cos(a) / cell, sin = Math.sin(a) / cell;
    const shape = HALFTONE_SHAPES.includes(opts.shape) ? opts.shape : 'round';
    const table = spotTable(shape);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const i = (y * w + x) * 4;
      // screen coordinates rotated by the screen angle (y up, as presses measure it), in cells
      const xr = x * cos - y * sin, yr = x * sin + y * cos;
      const s = spotValue(shape, xr - Math.floor(xr) - 0.5, yr - Math.floor(yr) - 0.5);
      const bin = Math.round((s - table.min) * table.scale);
      const t = table.cdf[bin < 0 ? 0 : bin > table.last ? table.last : bin];
      put(i, 1 - grey(i) / 255 <= t);
    }
    return img;
  }
  if (method === 'custom-pattern' && opts.pattern?.width > 0 && opts.pattern?.height > 0) {
    const p = opts.pattern, pw = p.width, ph = p.height, pd = p.data;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const i = (y * w + x) * 4, j = ((y % ph) * pw + (x % pw)) * 4;
      // tile greys 0..255 become thresholds strictly inside the range so white stays white and black black
      const t = (((pd[j] * 299 + pd[j + 1] * 587 + pd[j + 2] * 114) / 1000 + 0.5) * 255) / 256;
      put(i, grey(i) > t);
    }
    return img;
  }
  if (method === 'pattern-dither' || method === 'custom-pattern') {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const i = (y * w + x) * 4;
      put(i, grey(i) > ((BAYER8[(y & 7) * 8 + (x & 7)] + 0.5) * 255) / 64);
    }
    return img;
  }
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const i = (y * w + x) * 4;
    put(i, grey(i) >= 127.5);
  }
  return img;
}

// ---- duotone -----------------------------------------------------------------------------------------------------

export const DUOTONE_TYPES = Object.freeze(['monotone', 'duotone', 'tritone', 'quadtone']);
const LINEAR_CURVE = Object.freeze([[0, 0], [100, 100]]);

/**
 * Built-in ink sets (no Pantone names: the colours are plain sRGB). A curve maps the grey's ink
 * percentage (0 = paper white, 100 = black) to how much of that ink prints.
 */
export const DUOTONE_PRESETS = Object.freeze([
  { id: 'black', name: 'Black (monotone)', type: 'monotone', inks: [{ name: 'Black', color: '#000000', curve: [[0, 0], [100, 100]] }] },
  { id: 'sepia', name: 'Sepia', type: 'duotone', inks: [{ name: 'Black', color: '#000000', curve: [[0, 0], [50, 30], [100, 100]] }, { name: 'Sepia', color: '#a8713f', curve: [[0, 0], [50, 65], [100, 100]] }] },
  { id: 'cyanotype', name: 'Cyanotype', type: 'duotone', inks: [{ name: 'Black', color: '#000000', curve: [[0, 0], [60, 25], [100, 90]] }, { name: 'Prussian Blue', color: '#1b4f8f', curve: [[0, 0], [40, 60], [100, 100]] }] },
  { id: 'warm', name: 'Warm gray', type: 'duotone', inks: [{ name: 'Black', color: '#000000', curve: [[0, 0], [50, 40], [100, 100]] }, { name: 'Warm Gray', color: '#c2a383', curve: [[0, 0], [50, 70], [100, 100]] }] },
  { id: 'cool', name: 'Cool blue', type: 'duotone', inks: [{ name: 'Black', color: '#000000', curve: [[0, 0], [50, 40], [100, 100]] }, { name: 'Cool Blue', color: '#6f9fd8', curve: [[0, 0], [50, 70], [100, 100]] }] },
  { id: 'selenium', name: 'Selenium', type: 'duotone', inks: [{ name: 'Black', color: '#000000', curve: [[0, 0], [50, 45], [100, 100]] }, { name: 'Selenium', color: '#7b5a7d', curve: [[0, 0], [50, 55], [100, 85]] }] },
  { id: 'sunset', name: 'Black, orange, yellow', type: 'tritone', inks: [{ name: 'Black', color: '#000000', curve: [[0, 0], [60, 25], [100, 100]] }, { name: 'Orange', color: '#e8772e', curve: [[0, 0], [50, 55], [100, 90]] }, { name: 'Yellow', color: '#f6d13a', curve: [[0, 0], [30, 50], [100, 80]] }] },
  { id: 'process', name: 'Process quadtone', type: 'quadtone', inks: [{ name: 'Black', color: '#000000', curve: [[0, 0], [70, 30], [100, 100]] }, { name: 'Cyan', color: '#00a0e0', curve: [[0, 0], [50, 40], [100, 70]] }, { name: 'Magenta', color: '#e0007a', curve: [[0, 0], [50, 30], [100, 60]] }, { name: 'Yellow', color: '#ffe600', curve: [[0, 0], [50, 30], [100, 60]] }] },
]);

/** A complete duotone description: a known type, as many inks as the type has, each with name, '#rrggbb' colour and a curve. */
export function normalizeDuotone(duotone) {
  const src = duotone && typeof duotone === 'object' ? duotone : {};
  const inksIn = Array.isArray(src.inks) ? src.inks.filter((k) => k && typeof k === 'object') : [];
  let type = DUOTONE_TYPES.includes(src.type) ? src.type : DUOTONE_TYPES[Math.max(0, Math.min(3, inksIn.length - 1))] ?? 'monotone';
  const count = DUOTONE_TYPES.indexOf(type) + 1;
  const defaults = ['#000000', '#a8713f', '#e8772e', '#f6d13a'];
  const inks = [];
  for (let i = 0; i < count; i++) {
    const k = inksIn[i] ?? {};
    const rgb = toRgb(k.color, toRgb(defaults[i]));
    const curve = Array.isArray(k.curve) ? k.curve.filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1])).map((p) => [Math.max(0, Math.min(100, p[0])), Math.max(0, Math.min(100, p[1]))]) : [];
    inks.push({
      name: typeof k.name === 'string' && k.name.trim() ? k.name.trim() : i === 0 ? 'Black' : `Ink ${i + 1}`,
      color: '#' + rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join(''),
      curve: curve.length >= 2 ? curve.sort((a, b) => a[0] - b[0]) : LINEAR_CURVE.map((p) => [...p]),
    });
  }
  if (!DUOTONE_TYPES.includes(type)) type = 'monotone';
  return { type, inks };
}

/** Ink coverage (0..1) for each grey level 0..255 of one ink curve (index 0 = black = 100% in). */
export function inkCoverage(curve) {
  const lut = curveLut((curve?.length >= 2 ? curve : LINEAR_CURVE).map(([x, y]) => [x * 2.55, y * 2.55]));
  const out = new Float32Array(256);
  for (let v = 0; v < 256; v++) out[v] = lut[255 - v] / 255;
  return out;
}

/**
 * The colour of every grey level under a set of inks: 256 RGB triples (index = grey value). Each ink
 * filters white paper by its coverage at that grey (its curve), and inks overprint multiplicatively,
 * so black (grey 0) with straight curves is the product of the ink colours.
 * @param {{ type?: string, inks: { color: string|number[], curve?: number[][] }[] }} duotone
 * @param {number[]} [only] indices of the inks to print (Multichannel with deleted channels); default all
 * @returns {Uint8ClampedArray} 768 entries
 */
export function duotoneLut(duotone, only = null) {
  const inks = (duotone?.inks ?? []).map((k, i) => ({ rgb: toRgb(k.color), cover: inkCoverage(k.curve), on: !only || only.includes(i) })).filter((k) => k.on);
  const out = new Uint8ClampedArray(768);
  for (let v = 0; v < 256; v++) {
    let r = 1, g = 1, b = 1;
    for (const k of inks) {
      const c = k.cover[v];
      r *= 1 - c * (1 - k.rgb[0] / 255);
      g *= 1 - c * (1 - k.rgb[1] / 255);
      b *= 1 - c * (1 - k.rgb[2] / 255);
    }
    out[v * 3] = Math.round(r * 255);
    out[v * 3 + 1] = Math.round(g * 255);
    out[v * 3 + 2] = Math.round(b * 255);
  }
  return out;
}

/** Replaces each pixel by the ink colour of its grey (luma), in place. `lut` comes from duotoneLut(). */
export function applyDuotone(img, lut, rect = null) {
  const d = img.data, w = img.width;
  const { x0, y0, x1, y1 } = bounds(img, rect);
  for (let y = y0; y < y1; y++) for (let i = (y * w + x0) * 4, end = (y * w + x1) * 4; i < end; i += 4) {
    const v = ((d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114 + 500) / 1000 | 0) * 3;
    d[i] = lut[v];
    d[i + 1] = lut[v + 1];
    d[i + 2] = lut[v + 2];
  }
  return img;
}

// ---- constraints -------------------------------------------------------------------------------------------------

const MAPPERS = new WeakMap(); // colour table array -> Map(transparentIndex -> mapper)
function mapperFor(colorTable, transparentIndex = -1) {
  let byIndex = MAPPERS.get(colorTable);
  if (!byIndex) MAPPERS.set(colorTable, (byIndex = new Map()));
  let m = byIndex.get(transparentIndex);
  if (!m) byIndex.set(transparentIndex, (m = createMapper(colorTable, transparentIndex)));
  return m;
}
const LUTS = new WeakMap(); // duotone object -> lut
function lutFor(duotone) {
  let l = LUTS.get(duotone);
  if (!l) LUTS.set(duotone, (l = duotoneLut(duotone)));
  return l;
}

/**
 * The colour a mode can hold that is closest to `rgb`: its grey (grayscale, duotone), black or white
 * (bitmap), the nearest colour-table entry (indexed), or the colour itself.
 * @param {string} mode
 * @param {number[]} rgb [r, g, b] 0..255
 * @param {number[][]|null} [colorTable]
 * @param {number} [transparentIndex] the table entry that stands for transparency (never chosen)
 * @returns {number[]} [r, g, b]
 */
export function constrainColor(mode, rgb, colorTable = null, transparentIndex = -1) {
  const r = Math.max(0, Math.min(255, Math.round(rgb[0]))), g = Math.max(0, Math.min(255, Math.round(rgb[1]))), b = Math.max(0, Math.min(255, Math.round(rgb[2])));
  if (mode === 'grayscale' || mode === 'duotone') {
    const v = luma(r, g, b);
    return [v, v, v];
  }
  if (mode === 'bitmap') return luma(r, g, b) >= 128 ? [255, 255, 255] : [0, 0, 0];
  if (mode === 'indexed' && colorTable?.length) return colorTable[mapperFor(colorTable, transparentIndex).nearest(r, g, b)].slice(0, 3);
  return [r, g, b];
}

/**
 * Snaps the colours of an image to what the mode can hold, in place (alpha is kept): grey, black/white
 * or the nearest colour-table entry. RGB, CMYK, Lab and Multichannel images come back untouched.
 */
export function constrainImage(mode, img, colorTable = null, rect = null, transparentIndex = -1) {
  if (mode === 'grayscale' || mode === 'duotone') return toGrayscale(img, {}, rect);
  if (mode === 'bitmap') return toBitmap(img, { method: '50-threshold', keepAlpha: true }, rect);
  if (mode !== 'indexed' || !colorTable?.length) return img;
  const mapper = mapperFor(colorTable, transparentIndex);
  const d = img.data, w = img.width;
  const { x0, y0, x1, y1 } = bounds(img, rect);
  let prevKey = -1, pr = 0, pg = 0, pb = 0;
  for (let y = y0; y < y1; y++) for (let i = (y * w + x0) * 4, end = (y * w + x1) * 4; i < end; i += 4) {
    const key = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2];
    if (key !== prevKey) {
      prevKey = key;
      const c = colorTable[mapper.nearest(d[i], d[i + 1], d[i + 2])];
      pr = c[0];
      pg = c[1];
      pb = c[2];
    }
    d[i] = pr;
    d[i + 1] = pg;
    d[i + 2] = pb;
  }
  return img;
}

/**
 * What a document of this mode shows for composited pixels, in place: grey, black/white, the ink
 * colours of its greys, the nearest colour-table entries (with all-or-nothing alpha, as an indexed
 * image has), or the spot channels that are left of a multichannel image.
 * @param {{ colorTable?: number[][], transparentIndex?: number, duotone?: object, multichannel?: object }} [state]
 */
export function renderMode(img, mode, state = {}, rect = null) {
  switch (mode) {
    case 'grayscale': return toGrayscale(img, {}, rect);
    case 'bitmap': return toBitmap(img, { method: '50-threshold', keepAlpha: true }, rect);
    case 'duotone': return state.duotone?.inks?.length ? applyDuotone(img, lutFor(state.duotone), rect) : toGrayscale(img, {}, rect);
    case 'indexed': {
      if (!state.colorTable?.length) return img;
      constrainImage('indexed', img, state.colorTable, rect, state.transparentIndex ?? -1);
      const d = img.data, w = img.width;
      const { x0, y0, x1, y1 } = bounds(img, rect);
      for (let y = y0; y < y1; y++) for (let i = (y * w + x0) * 4 + 3, end = (y * w + x1) * 4; i < end; i += 4) d[i] = d[i] >= 128 ? 255 : 0;
      return img;
    }
    case 'multichannel': return state.multichannel ? renderMultichannel(img, state.multichannel, rect) : img;
    default: return img;
  }
}

// ---- channels ----------------------------------------------------------------------------------------------------

/**
 * The channels of an image as grey planes, the way the Channels panel shows them (and loads them as
 * selections): RGB and grey values weighted by alpha, CMYK inks as Photoshop draws them (white = no
 * ink, transparent areas are bare paper), Lab with a and b centred on mid grey.
 * @returns {{ id: string, name: string, ink: boolean, data: Uint8ClampedArray }[]} one plane of width*height per channel of MODES[mode]
 */
export function channelPlanes(img, mode = 'rgb') {
  const info = MODES[mode] ?? MODES.rgb;
  const n = img.width * img.height, d = img.data;
  // `ink` marks planes drawn the way presses think: 255 = no ink, 0 = solid ink
  const planes = info.channels.map((c) => ({ id: c.id, name: c.name, ink: mode === 'cmyk', data: new Uint8ClampedArray(n) }));
  if (mode === 'cmyk') {
    const [C, M, Y, K] = planes.map((p) => p.data);
    for (let p = 0, i = 0; p < n; p++, i += 4) {
      const a = d[i + 3] / 255;
      // on white paper: what is not covered by the pixel prints nothing
      const r = 255 + (d[i] - 255) * a, g = 255 + (d[i + 1] - 255) * a, b = 255 + (d[i + 2] - 255) * a;
      const max = Math.max(r, g, b);
      if (max <= 0) {
        C[p] = M[p] = Y[p] = 255;
        K[p] = 0;
        continue;
      }
      // coverage c = (max - r) / max; drawn as 255 * (1 - c)
      C[p] = (r / max) * 255;
      M[p] = (g / max) * 255;
      Y[p] = (b / max) * 255;
      K[p] = max;
    }
    return planes;
  }
  if (mode === 'lab') {
    const [L, A, B] = planes.map((p) => p.data);
    const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
    for (let p = 0, i = 0; p < n; p++, i += 4) {
      const a = d[i + 3] / 255;
      const R = LINEAR[d[i]], G = LINEAR[d[i + 1]], Bl = LINEAR[d[i + 2]];
      const fx = f((R * 0.4124564 + G * 0.3575761 + Bl * 0.1804375) / 0.95047), fy = f(R * 0.2126729 + G * 0.7151522 + Bl * 0.072175), fz = f((R * 0.0193339 + G * 0.119192 + Bl * 0.9503041) / 1.08883);
      L[p] = (116 * fy - 16) * 2.55 * a;
      A[p] = 128 + 500 * (fx - fy) * a;
      B[p] = 128 + 200 * (fy - fz) * a;
    }
    return planes;
  }
  if (mode === 'rgb') {
    const [R, G, B] = planes.map((p) => p.data);
    for (let p = 0, i = 0; p < n; p++, i += 4) {
      const a = d[i + 3] / 255;
      R[p] = d[i] * a;
      G[p] = d[i + 1] * a;
      B[p] = d[i + 2] * a;
    }
    return planes;
  }
  if (planes.length) {
    // single-channel modes: the grey of what is shown
    const G = planes[0].data;
    for (let p = 0, i = 0; p < n; p++, i += 4) G[p] = ((d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000) * (d[i + 3] / 255);
  }
  return planes;
}

// ---- multichannel ------------------------------------------------------------------------------------------------

const SPOTS = {
  c: { name: 'Cyan', color: [0, 255, 255] },
  m: { name: 'Magenta', color: [255, 0, 255] },
  y: { name: 'Yellow', color: [255, 255, 0] },
  k: { name: 'Black', color: [0, 0, 0] },
};

/**
 * Splits an image into the spot channels Multichannel mode keeps (Photoshop: "useful for specialised
 * printing"): RGB gives Cyan, Magenta and Yellow (the inverted Red, Green and Blue), CMYK its four
 * inks, Grayscale one Black channel, Duotone one channel per ink (through its curve) and Lab three
 * unnamed alpha channels. Planes are drawn like every ink channel: 255 = no ink.
 * @param {string} from the mode the pixels are in
 * @param {{ duotone?: object }} [opts]
 * @returns {{ key: string, name: string, color: number[]|null, data: Uint8ClampedArray }[]}
 */
export function splitChannels(img, from, { duotone = null } = {}) {
  const n = img.width * img.height, d = img.data;
  const make = (key, name, color) => ({ key, name, color, data: new Uint8ClampedArray(n) });
  if (from === 'cmyk') {
    const planes = channelPlanes(img, 'cmyk');
    return planes.map((p) => ({ key: p.id, name: p.name, color: SPOTS[p.id].color, data: p.data }));
  }
  if (from === 'lab') return channelPlanes(img, 'lab').map((p, i) => ({ key: p.id, name: `Alpha ${i + 1}`, color: null, data: p.data }));
  if (from === 'duotone' && duotone?.inks?.length) {
    const inks = duotone.inks.map((k, i) => ({ plane: make(`ink${i}`, k.name || `Ink ${i + 1}`, toRgb(k.color)), cover: inkCoverage(k.curve) }));
    for (let p = 0, i = 0; p < n; p++, i += 4) {
      const a = d[i + 3] / 255;
      const v = luma(d[i], d[i + 1], d[i + 2]);
      for (const k of inks) k.plane.data[p] = 255 - k.cover[v] * 255 * a;
    }
    return inks.map((k) => k.plane);
  }
  if (from === 'grayscale' || from === 'bitmap' || from === 'duotone') {
    const k = make('k', 'Black', SPOTS.k.color);
    for (let p = 0, i = 0; p < n; p++, i += 4) k.data[p] = 255 - (255 - luma(d[i], d[i + 1], d[i + 2])) * (d[i + 3] / 255);
    return [k];
  }
  // RGB (and anything stored like it): each ink is the complement of one primary
  const out = [make('c', SPOTS.c.name, SPOTS.c.color), make('m', SPOTS.m.name, SPOTS.m.color), make('y', SPOTS.y.name, SPOTS.y.color)];
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    const a = d[i + 3] / 255;
    out[0].data[p] = 255 - (255 - d[i]) * a;
    out[1].data[p] = 255 - (255 - d[i + 1]) * a;
    out[2].data[p] = 255 - (255 - d[i + 2]) * a;
  }
  return out;
}

/**
 * Shows multichannel pixels through the spot channels that still exist, in place. `multi` is
 * { source: the mode the image was split from, keys: the keys of the remaining channels, duotone? }.
 * With every channel present an RGB, CMYK or grey image is unchanged; a missing ink prints nothing.
 */
export function renderMultichannel(img, multi, rect = null) {
  const keys = new Set(multi?.keys ?? []);
  const source = multi?.source ?? 'rgb';
  const d = img.data, w = img.width;
  const { x0, y0, x1, y1 } = bounds(img, rect);
  if (source === 'duotone' && multi.duotone?.inks?.length) {
    const only = multi.duotone.inks.map((_, i) => i).filter((i) => keys.has(`ink${i}`));
    return applyDuotone(img, duotoneLut(multi.duotone, only), rect);
  }
  if (source === 'lab') return img;
  if (source === 'grayscale' || source === 'bitmap' || source === 'duotone') {
    if (keys.has('k')) return img;
    for (let y = y0; y < y1; y++) for (let i = (y * w + x0) * 4, end = (y * w + x1) * 4; i < end; i += 4) d[i] = d[i + 1] = d[i + 2] = 255;
    return img;
  }
  const hasC = keys.has('c'), hasM = keys.has('m'), hasY = keys.has('y');
  if (source === 'cmyk') {
    const hasK = keys.has('k');
    if (hasC && hasM && hasY && hasK) return img;
    for (let y = y0; y < y1; y++) for (let i = (y * w + x0) * 4, end = (y * w + x1) * 4; i < end; i += 4) {
      const cmyk = rgbToCmyk(d[i], d[i + 1], d[i + 2]);
      const rgb = cmykToRgb(hasC ? cmyk[0] : 0, hasM ? cmyk[1] : 0, hasY ? cmyk[2] : 0, hasK ? cmyk[3] : 0);
      d[i] = Math.round(rgb[0]);
      d[i + 1] = Math.round(rgb[1]);
      d[i + 2] = Math.round(rgb[2]);
    }
    return img;
  }
  if (hasC && hasM && hasY) return img;
  for (let y = y0; y < y1; y++) for (let i = (y * w + x0) * 4, end = (y * w + x1) * 4; i < end; i += 4) {
    if (!hasC) d[i] = 255;
    if (!hasM) d[i + 1] = 255;
    if (!hasY) d[i + 2] = 255;
  }
  return img;
}

// ---- trapping ------------------------------------------------------------------------------------------------------

/**
 * Trap (CMYK): where two colours abut, the lighter one is spread under the darker one by `width`
 * pixels so a press that misregisters shows no white gap. Works on the derived C, M, Y and K planes:
 * a pixel next to a clearly lighter and different colour takes the larger of its own and that
 * neighbour's coverage per ink, and the gained ink then travels `width` pixels into the darker area.
 * Pixels away from colour boundaries are not touched (no round trip through CMYK for them).
 * @param {{ width, height, data }} img
 * @param {{ width?: number }} [opts] trap width in pixels, 1..10
 */
export function trap(img, { width = 1 } = {}, rect = null) {
  const w = img.width, h = img.height, d = img.data, n = w * h;
  const steps = Math.max(1, Math.min(10, Math.round(Number(width) || 1)));
  // ink coverage 0..255 per plane and the lightness used to decide which side is darker
  const ink = [new Uint8Array(n), new Uint8Array(n), new Uint8Array(n), new Uint8Array(n)];
  const light = new Uint8Array(n);
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    const max = Math.max(r, g, b);
    if (max > 0) {
      ink[0][p] = Math.round(((max - r) / max) * 255);
      ink[1][p] = Math.round(((max - g) / max) * 255);
      ink[2][p] = Math.round(((max - b) / max) * 255);
    }
    ink[3][p] = 255 - max;
    light[p] = (r * 299 + g * 587 + b * 114) / 1000;
  }
  const EDGE = 64; // a quarter of the ink range in one plane makes two neighbours "different colours"
  const differs = (p, q) => Math.abs(ink[0][p] - ink[0][q]) >= EDGE || Math.abs(ink[1][p] - ink[1][q]) >= EDGE || Math.abs(ink[2][p] - ink[2][q]) >= EDGE || Math.abs(ink[3][p] - ink[3][q]) >= EDGE;
  let gain = [new Uint8Array(n), new Uint8Array(n), new Uint8Array(n)]; // black never spreads: it is the darkest ink
  let touched = new Uint8Array(n);
  const neighbours = [-w - 1, -w, -w + 1, -1, 1, w - 1, w, w + 1];
  const dx = [-1, 0, 1, -1, 1, -1, 0, 1], dy = [-1, -1, -1, 0, 0, 1, 1, 1];
  // step 1: darker pixels on a boundary take the inks of their lighter neighbours
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = y * w + x;
    if (!d[p * 4 + 3]) continue;
    for (let k = 0; k < 8; k++) {
      const nx = x + dx[k], ny = y + dy[k];
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const q = p + neighbours[k];
      if (!d[q * 4 + 3] || light[q] <= light[p] + 8 || !differs(p, q)) continue;
      for (let c = 0; c < 3; c++) if (ink[c][q] > gain[c][p]) gain[c][p] = ink[c][q];
      touched[p] = 1;
    }
  }
  // further steps: the gained ink moves on inside the darker colour (never back across the boundary)
  for (let s = 1; s < steps; s++) {
    const next = gain.map((g) => g.slice());
    const nextTouched = touched.slice();
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (touched[p] || !d[p * 4 + 3]) continue;
      for (let k = 0; k < 8; k++) {
        const nx = x + dx[k], ny = y + dy[k];
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const q = p + neighbours[k];
        if (!touched[q] || differs(p, q)) continue;
        for (let c = 0; c < 3; c++) if (gain[c][q] > next[c][p]) next[c][p] = gain[c][q];
        nextTouched[p] = 1;
      }
    }
    gain = next;
    touched = nextTouched;
  }
  const { x0, y0, x1, y1 } = bounds(img, rect);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const p = y * w + x;
    if (!touched[p]) continue;
    const c = Math.max(ink[0][p], gain[0][p]), m = Math.max(ink[1][p], gain[1][p]), yy = Math.max(ink[2][p], gain[2][p]);
    if (c === ink[0][p] && m === ink[1][p] && yy === ink[2][p]) continue;
    const kk = 255 - ink[3][p];
    const i = p * 4;
    d[i] = Math.round(((255 - c) * kk) / 255);
    d[i + 1] = Math.round(((255 - m) * kk) / 255);
    d[i + 2] = Math.round(((255 - yy) * kk) / 255);
  }
  return img;
}

// ---- conversion ----------------------------------------------------------------------------------------------------

/**
 * Converts pixels from one mode to another and returns a new image (the input is not modified):
 * { width, height, data, mode } plus what the target mode needs: `colorTable`, `indices` and
 * `transparentIndex` (indexed), `duotone` (duotone), `channels` and `multichannel` (multichannel).
 *
 * Pairs Photoshop offers directly run in one step; any other pair runs through conversionPath()
 * (RGB → Bitmap goes through Grayscale). Leaving a mode bakes what it shows into the pixels: duotone
 * greys become ink colours, a multichannel image loses the inks of its deleted channels.
 *
 * options:
 *   source: { colorTable, transparentIndex, duotone, multichannel } of the image being converted
 *   grayscale: method 'luma' | 'luminance' (see toGrayscale)
 *   bitmap: method, frequency, angle, shape, dpi, pattern (see toBitmap)
 *   duotone: duotone { type, inks } (default: a black monotone)
 *   indexed: colors, palette, forced, transparency, matte, dither, ditherAmount, preserveExactColors, custom (see quantize.js)
 */
export function convertPixels(img, from, to, options = {}) {
  const path = conversionPath(from, to);
  if (!path) throw new Error(`Cannot convert ${from} to ${to}`);
  let out = { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data), mode: from };
  let source = options.source ?? {};
  for (let s = 1; s < path.length; s++) {
    out = convertStep(out, path[s - 1], path[s], options, source);
    // the next step of a chain converts what this step produced
    source = { colorTable: out.colorTable, transparentIndex: out.transparentIndex, duotone: out.duotone, multichannel: out.multichannel };
  }
  return out;
}

function convertStep(img, from, to, options, source) {
  const out = { width: img.width, height: img.height, data: img.data, mode: to };
  // what the source mode shows becomes the pixels (grey stays grey for the modes that are grey underneath)
  const bake = () => {
    if (from === 'duotone' && (to === 'grayscale' || to === 'bitmap' || to === 'duotone' || to === 'multichannel')) return;
    renderMode(out, from, source);
  };
  switch (to) {
    case 'grayscale':
      bake();
      toGrayscale(out, { method: options.method === 'luminance' ? 'luminance' : 'luma' });
      break;
    case 'bitmap':
      bake();
      toBitmap(out, options);
      break;
    case 'duotone':
      bake();
      toGrayscale(out);
      out.duotone = normalizeDuotone(options.duotone ?? DUOTONE_PRESETS[0]);
      break;
    case 'indexed': {
      bake();
      const q = quantize(out, options);
      out.data = indicesToImage(q.indices, q.palette, out.width, out.height, q.transparentIndex).data;
      out.colorTable = q.palette;
      out.indices = q.indices;
      out.transparentIndex = q.transparentIndex;
      break;
    }
    case 'multichannel': {
      bake();
      const duotone = from === 'duotone' ? source.duotone ?? null : null;
      const channels = splitChannels(out, from, { duotone });
      out.channels = channels;
      out.multichannel = { source: from === 'bitmap' ? 'grayscale' : from, keys: channels.map((c) => c.key), duotone: duotone ? normalizeDuotone(duotone) : null };
      break;
    }
    default:
      // rgb, cmyk, lab: unconstrained; the stored pixels are what the old mode showed
      bake();
  }
  return out;
}
