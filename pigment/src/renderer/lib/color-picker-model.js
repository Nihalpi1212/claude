// The colour UI's pure parts (ARCHITECTURE.md "0.5 features", S7; color-picker-swatches, package 11). Node-safe: no
// DOM, no app; the conversions that depend on the document's profile (Lab) are passed in as `conv = { toLab(rgb),
// fromLab(lab) }`, so the picker uses icc-engine's numbers when it has landed and 0.4's sRGB maths without it.
//
//   Picker axes (Photoshop's radio buttons): AXES, axisOf(id), the colour state { hsv, rgb, lab } and its moves:
//     stateFromRgb / stateFromHsv / stateFromLab, axisPosition(axis, state) -> { x, y, t },
//     fromField(axis, state, x, y, conv), fromStrip(axis, state, t, conv), fieldRgb / stripRgb (drawing)
//   Web colours: webSafe(rgb), isWebSafe(rgb).  Lab gamut: labClipped(lab, conv).
//   The HUD colour picker: HudModel (geometry and zones of the hue strip and the hue wheel) and HudController (the
//     session's state machine: live colour, cancel restores, up remembers), addRecentColor.
//   Swatches (kind `swatches`, S7.2): normalizeSwatchData, swatchFromHex, migrateSwatchList, filterSwatches.
//   Colour books: parseAcb / writeAcb (Adobe Color Book), bookFromAse, bookColorName, filterBookColors.
//   Eyedropper: SAMPLE_SIZES, SAMPLE_SOURCES, sampleSourceOf, averageRgba, hexCode, htmlCode.
import { rgbToHsv, hsvToRgb, rgbToLab, labToRgb, rgbaToHex, parseColor, isOutOfCmykGamut, proofRgb } from '../../shared/pixels/color.js';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const clamp01 = (v) => clamp(v, 0, 1);
const finite = (v, d = 0) => (Number.isFinite(v) ? v : d);

/** The sRGB D65 maths of 0.4 (what the pipeline answers without an engine). */
export const SRGB_CONV = Object.freeze({
  toLab: (rgb) => rgbToLab(rgb[0], rgb[1], rgb[2]),
  fromLab: (lab) => labToRgb(lab[0], lab[1], lab[2]).map((v) => clamp(Math.round(v), 0, 255)),
});

export const hexOfRgb = (rgb) => rgbaToHex([0, 1, 2].map((i) => clamp(Math.round(finite(rgb?.[i])), 0, 255)));
export const rgbOfHex = (hex) => parseColor(hex).slice(0, 3).map((v) => clamp(Math.round(v), 0, 255));

// ---- picker axes -------------------------------------------------------------------------------------------------

/**
 * Photoshop's nine axes. The strip shows the axis' own component (t: 0 at the bottom, 1 at the top), the field the
 * other two (x left to right, y top to bottom).
 */
export const AXES = Object.freeze([
  { id: 'h', label: 'H', model: 'hsb' },
  { id: 's', label: 'S', model: 'hsb' },
  { id: 'v', label: 'B', model: 'hsb' },
  { id: 'r', label: 'R', model: 'rgb' },
  { id: 'g', label: 'G', model: 'rgb' },
  { id: 'b', label: 'B', model: 'rgb' },
  { id: 'L', label: 'L', model: 'lab' },
  { id: 'A', label: 'a', model: 'lab' },
  { id: 'B', label: 'b', model: 'lab' },
]);
export const axisOf = (id) => AXES.find((a) => a.id === id) ?? AXES[0];

/** The picker's colour: HSB keeps the hue of greys; Lab is what was typed, or the RGB's Lab. */
export function stateFromRgb(rgb, conv = SRGB_CONV, prev = null) {
  const c = [0, 1, 2].map((i) => clamp(finite(rgb?.[i]), 0, 255));
  let [h, s, v] = rgbToHsv(c[0], c[1], c[2]);
  // a grey (or black) keeps the hue, and black the saturation, the user had chosen
  if (prev && (s < 1e-6 || v < 1e-6)) h = prev.hsv.h;
  if (prev && v < 1e-6) s = prev.hsv.s;
  return { hsv: { h, s, v }, rgb: c, lab: conv.toLab(c.map(Math.round)) };
}

export function stateFromHsv(hsv, conv = SRGB_CONV) {
  const h = ((finite(hsv.h) % 360) + 360) % 360, s = clamp01(finite(hsv.s)), v = clamp01(finite(hsv.v));
  const rgb = hsvToRgb(h, s, v);
  return { hsv: { h: hsv.h >= 360 ? 359.999 : h, s, v }, rgb, lab: conv.toLab(rgb.map(Math.round)) };
}

export function stateFromLab(lab, conv = SRGB_CONV, prev = null) {
  const L = clamp(finite(lab[0]), 0, 100), a = clamp(finite(lab[1]), -128, 127), b = clamp(finite(lab[2]), -128, 127);
  const rgb = conv.fromLab([L, a, b]);
  const st = stateFromRgb(rgb, conv, prev);
  st.lab = [L, a, b];
  return st;
}

export const stateHex = (st) => hexOfRgb(st.rgb);

/** Where the state sits on the axis' field (x, y in 0..1) and strip (t in 0..1, 1 at the top). */
export function axisPosition(axis, st) {
  const { h, s, v } = st.hsv;
  const [r, g, b] = st.rgb;
  const [L, A, B] = st.lab;
  const la = (x) => (x + 128) / 255;
  switch (axis) {
    case 's': return { x: h / 360, y: 1 - v, t: s };
    case 'v': return { x: h / 360, y: 1 - s, t: v };
    case 'r': return { x: b / 255, y: 1 - g / 255, t: r / 255 };
    case 'g': return { x: b / 255, y: 1 - r / 255, t: g / 255 };
    case 'b': return { x: r / 255, y: 1 - g / 255, t: b / 255 };
    case 'L': return { x: la(A), y: 1 - la(B), t: L / 100 };
    case 'A': return { x: la(B), y: 1 - L / 100, t: la(A) };
    case 'B': return { x: la(A), y: 1 - L / 100, t: la(B) };
    default: return { x: s, y: 1 - v, t: h / 360 };
  }
}

const labOf = (x) => x * 255 - 128;

/** The state after a click or drag at (x, y) of the axis' field. */
export function fromField(axis, st, x, y, conv = SRGB_CONV) {
  x = clamp01(x);
  y = clamp01(y);
  const { h, s, v } = st.hsv;
  const [r, g, b] = st.rgb;
  const [L, A, B] = st.lab;
  switch (axis) {
    case 's': return stateFromHsv({ h: Math.min(359.999, x * 360), s, v: 1 - y }, conv);
    case 'v': return stateFromHsv({ h: Math.min(359.999, x * 360), s: 1 - y, v }, conv);
    case 'r': return stateFromRgb([r, (1 - y) * 255, x * 255], conv, st);
    case 'g': return stateFromRgb([(1 - y) * 255, g, x * 255], conv, st);
    case 'b': return stateFromRgb([x * 255, (1 - y) * 255, b], conv, st);
    case 'L': return stateFromLab([L, labOf(x), labOf(1 - y)], conv, st);
    case 'A': return stateFromLab([(1 - y) * 100, A, labOf(x)], conv, st);
    case 'B': return stateFromLab([(1 - y) * 100, labOf(x), B], conv, st);
    default: return stateFromHsv({ h, s: x, v: 1 - y }, conv);
  }
}

/** The state after a click or drag on the strip at t (1 at the top). */
export function fromStrip(axis, st, t, conv = SRGB_CONV) {
  t = clamp01(t);
  const { h, s, v } = st.hsv;
  const [r, g, b] = st.rgb;
  const [L, A, B] = st.lab;
  switch (axis) {
    case 's': return stateFromHsv({ h, s: t, v }, conv);
    case 'v': return stateFromHsv({ h, s, v: t }, conv);
    case 'r': return stateFromRgb([t * 255, g, b], conv, st);
    case 'g': return stateFromRgb([r, t * 255, b], conv, st);
    case 'b': return stateFromRgb([r, g, t * 255], conv, st);
    case 'L': return stateFromLab([t * 100, A, B], conv, st);
    case 'A': return stateFromLab([L, labOf(t), B], conv, st);
    case 'B': return stateFromLab([L, A, labOf(t)], conv, st);
    default: return stateFromHsv({ h: Math.min(359.999, t * 360), s, v }, conv);
  }
}

/** RGB (0..255, unrounded) of the field at (x, y) for the current state: what the field canvas draws. */
export function fieldRgb(axis, st, x, y, conv = SRGB_CONV) {
  const { h, s, v } = st.hsv;
  const [r, g, b] = st.rgb;
  const [L, A, B] = st.lab;
  switch (axis) {
    case 's': return hsvToRgb(x * 360, s, 1 - y);
    case 'v': return hsvToRgb(x * 360, 1 - y, v);
    case 'r': return [r, (1 - y) * 255, x * 255];
    case 'g': return [(1 - y) * 255, g, x * 255];
    case 'b': return [x * 255, (1 - y) * 255, b];
    case 'L': return conv.fromLab([L, labOf(x), labOf(1 - y)]);
    case 'A': return conv.fromLab([(1 - y) * 100, A, labOf(x)]);
    case 'B': return conv.fromLab([(1 - y) * 100, labOf(x), B]);
    default: return hsvToRgb(h, x, 1 - y);
  }
}

/** RGB of the strip at t (1 at the top). The hue strip shows pure hues, as Photoshop's. */
export function stripRgb(axis, st, t, conv = SRGB_CONV) {
  const { h, s, v } = st.hsv;
  const [r, g, b] = st.rgb;
  const [L, A, B] = st.lab;
  switch (axis) {
    case 's': return hsvToRgb(h, t, v);
    case 'v': return hsvToRgb(h, s, t);
    case 'r': return [t * 255, g, b];
    case 'g': return [r, t * 255, b];
    case 'b': return [r, g, t * 255];
    case 'L': return conv.fromLab([t * 100, A, B]);
    case 'A': return conv.fromLab([L, labOf(t), B]);
    case 'B': return conv.fromLab([L, A, labOf(t)]);
    default: return hsvToRgb(t * 360, 1, 1);
  }
}

/**
 * Fills an RGBA buffer (w x h) with the axis' field: the picker's and the Color panel's canvases. `web` posterises it
 * to the web-safe colours (Only Web Colors).
 */
export function renderField(axis, st, data, w, h, { conv = SRGB_CONV, web = false } = {}) {
  for (let y = 0; y < h; y++) {
    const fy = h > 1 ? y / (h - 1) : 0;
    for (let x = 0; x < w; x++) {
      let c = fieldRgb(axis, st, w > 1 ? x / (w - 1) : 0, fy, conv);
      if (web) c = webSafe(c);
      const o = (y * w + x) * 4;
      data[o] = c[0];
      data[o + 1] = c[1];
      data[o + 2] = c[2];
      data[o + 3] = 255;
    }
  }
  return data;
}

/** The strip as a column of `h` RGB rows (top first). */
export function renderStrip(axis, st, data, w, h, { conv = SRGB_CONV, web = false } = {}) {
  for (let y = 0; y < h; y++) {
    let c = stripRgb(axis, st, h > 1 ? 1 - y / (h - 1) : 1, conv);
    if (web) c = webSafe(c);
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      data[o] = c[0];
      data[o + 1] = c[1];
      data[o + 2] = c[2];
      data[o + 3] = 255;
    }
  }
  return data;
}

// ---- web colours and gamut ---------------------------------------------------------------------------------------

/** The nearest of the 216 web-safe colours (each channel a multiple of 0x33). */
export const webSafe = (rgb) => [0, 1, 2].map((i) => clamp(Math.round(finite(rgb?.[i]) / 51) * 51, 0, 255));
export const isWebSafe = (rgb) => [0, 1, 2].every((i) => Math.round(finite(rgb?.[i])) % 51 === 0);

/**
 * The closest printable colour (sRGB numbers) for the picker's and the Color panel's out-of-gamut warning: the press's
 * proof of the colour (View > Gamut Warning's model), proofed again while that is still flagged, and, if it never
 * settles, moved toward its own grey until the gamut test passes. A printable colour is returned as it is.
 */
export function printableRgb(rgb) {
  let c = [0, 1, 2].map((i) => clamp(Math.round(finite(rgb?.[i])), 0, 255));
  if (!isOutOfCmykGamut(c)) return c;
  for (let i = 0; i < 6 && isOutOfCmykGamut(c); i++) c = proofRgb(c[0], c[1], c[2]).map((v) => clamp(Math.round(v), 0, 255));
  if (!isOutOfCmykGamut(c)) return c;
  const grey = Math.round(0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]);
  let lo = 0, hi = 1; // the share of grey
  for (let i = 0; i < 16; i++) {
    const t = (lo + hi) / 2;
    if (isOutOfCmykGamut(c.map((v) => v + (grey - v) * t))) lo = t;
    else hi = t;
  }
  return c.map((v) => clamp(Math.round(v + (grey - v) * hi), 0, 255));
}

/** CIE76 difference of two Lab colours. */
export const deltaE = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/**
 * True when a Lab colour lies outside the document profile's gamut: its RGB numbers, read back as Lab, land more
 * than 1.5 ΔE away (the RGB was clipped). The conversions are the pipeline's, so this is the real gamut once an
 * engine has landed.
 */
export function labClipped(lab, conv = SRGB_CONV) {
  const rgb = conv.fromLab(lab);
  if (!rgb) return false;
  const back = conv.toLab(rgb.map((v) => clamp(Math.round(v), 0, 255)));
  return !!back && deltaE(lab, back) > 1.5;
}

// ---- the HUD colour picker ---------------------------------------------------------------------------------------

/** settings.colorUI.hud values: Photoshop's Hue Strip and Hue Wheel, small, medium and large. */
export const HUD_STYLES = Object.freeze([
  ['hue-strip-small', 'Hue Strip (Small)'],
  ['hue-strip', 'Hue Strip (Medium)'],
  ['hue-strip-large', 'Hue Strip (Large)'],
  ['hue-wheel-small', 'Hue Wheel (Small)'],
  ['hue-wheel', 'Hue Wheel (Medium)'],
  ['hue-wheel-large', 'Hue Wheel (Large)'],
]);

export function hudStyle(value) {
  const v = HUD_STYLES.some(([id]) => id === value) ? value : 'hue-strip';
  const layout = v.startsWith('hue-wheel') ? 'wheel' : 'strip';
  const size = v.endsWith('-small') ? 120 : v.endsWith('-large') ? 220 : 160;
  return { id: v, layout, size };
}

/**
 * Geometry and zones of the HUD (panel-local CSS pixels, origin at the panel's top-left). The strip layout is a
 * saturation/brightness square with the hue strip to its right; the wheel layout a hue ring around the square.
 * A move in the hue zone sets the hue only, a move in the square the saturation and brightness only, so the hue
 * chosen in the strip stays while the pointer goes back into the square (Photoshop's HUD).
 */
export class HudModel {
  constructor({ hsv = { h: 0, s: 0, v: 0 }, layout = 'strip', size = 160 } = {}) {
    this.hsv = { h: finite(hsv.h), s: clamp01(finite(hsv.s)), v: clamp01(finite(hsv.v)) };
    this.layout = layout === 'wheel' ? 'wheel' : 'strip';
    const pad = 8;
    if (this.layout === 'strip') {
      const gap = Math.round(size * 0.08), w = Math.round(size * 0.14);
      this.square = { x: pad, y: pad, size };
      this.strip = { x: pad + size + gap, y: pad, width: w, height: size };
      this.width = pad * 2 + size + gap + w;
      this.height = pad * 2 + size;
    } else {
      const ring = Math.round(size * 0.16), gap = Math.round(size * 0.06);
      const outer = Math.round((size * Math.SQRT2) / 2) + gap + ring;
      this.center = { x: pad + outer, y: pad + outer };
      this.ring = { inner: outer - ring, outer };
      this.square = { x: this.center.x - size / 2, y: this.center.y - size / 2, size };
      this.width = this.height = pad * 2 + outer * 2;
    }
    this.zone = 'square';
  }

  /** The point of the current colour in the square: where the press lands when the HUD opens. */
  anchor() {
    const q = this.square;
    return { x: q.x + this.hsv.s * q.size, y: q.y + (1 - this.hsv.v) * q.size };
  }

  /** The point that shows the hue: on the strip, or on the ring. */
  hueMarker() {
    if (this.layout === 'strip') return { x: this.strip.x + this.strip.width / 2, y: this.strip.y + (this.hsv.h / 360) * this.strip.height };
    const a = (this.hsv.h / 360) * Math.PI * 2 - Math.PI / 2;
    const r = (this.ring.inner + this.ring.outer) / 2;
    return { x: this.center.x + Math.cos(a) * r, y: this.center.y + Math.sin(a) * r };
  }

  zoneAt(x, y) {
    if (this.layout === 'strip') return x >= this.square.x + this.square.size + (this.strip.x - this.square.x - this.square.size) / 2 ? 'hue' : 'square';
    const d = Math.hypot(x - this.center.x, y - this.center.y);
    const edge = (this.square.size * Math.SQRT2) / 2;
    return d >= (edge + this.ring.inner) / 2 ? 'hue' : 'square';
  }

  /** A pointer move at panel-local (x, y): returns the new HSB and the zone it was read in. */
  move(x, y) {
    this.zone = this.zoneAt(x, y);
    if (this.zone === 'hue') {
      if (this.layout === 'strip') this.hsv.h = Math.min(359.999, clamp01((y - this.strip.y) / this.strip.height) * 360);
      else {
        let a = (Math.atan2(y - this.center.y, x - this.center.x) + Math.PI / 2) * (180 / Math.PI);
        a = ((a % 360) + 360) % 360;
        this.hsv.h = Math.min(359.999, a);
      }
    } else {
      const q = this.square;
      this.hsv.s = clamp01((x - q.x) / q.size);
      this.hsv.v = clamp01(1 - (y - q.y) / q.size);
    }
    return { hsv: { ...this.hsv }, zone: this.zone };
  }
}

/** settings.recentColors with `hex` first (no repeats), at most `max`. */
export function addRecentColor(list, hex, max = 14) {
  const h = hexOfRgb(rgbOfHex(hex));
  return [h, ...(Array.isArray(list) ? list : []).map((c) => hexOfRgb(rgbOfHex(c))).filter((c) => c !== h)].slice(0, max);
}

/**
 * The HUD session's state machine (S7.1, review decision 2): the picker, not the gesture, applies the colour.
 * `host` = { setForeground(hex), remember(hex), done(value | null) }; `view` (optional) = { update(model, hex),
 * destroy() } draws it. move(x, y) takes panel-local points; a move that changes the colour sets the foreground live
 * (no history entry); cancel() restores the initial colour; up() remembers the colour in the recent colours. The
 * first of up / cancel ends the session; later calls do nothing.
 */
export class HudController {
  constructor({ initial = '#000000', layout = 'strip', size = 160, host, view = null } = {}) {
    this.initial = hexOfRgb(rgbOfHex(initial));
    const [h, s, v] = rgbToHsv(...rgbOfHex(this.initial));
    this.model = new HudModel({ hsv: { h, s, v }, layout, size });
    this.hex = this.initial;
    this.host = host;
    this.view = view;
    this.open = true;
    view?.update?.(this.model, this.hex);
  }

  get anchor() {
    return this.model.anchor();
  }

  move(x, y) {
    if (!this.open) return this.hex;
    const { hsv } = this.model.move(x, y);
    const hex = hexOfRgb(hsvToRgb(hsv.h, hsv.s, hsv.v));
    if (hex !== this.hex) {
      this.hex = hex;
      this.host?.setForeground?.(hex);
    }
    this.view?.update?.(this.model, this.hex);
    return this.hex;
  }

  up(x, y) {
    if (!this.open) return null;
    if (Number.isFinite(x) && Number.isFinite(y)) this.move(x, y);
    this.open = false;
    this.host?.remember?.(this.hex);
    this.view?.destroy?.();
    this.host?.done?.(this.hex);
    return this.hex;
  }

  cancel() {
    if (!this.open) return;
    this.open = false;
    if (this.hex !== this.initial) this.host?.setForeground?.(this.initial);
    this.hex = this.initial;
    this.view?.destroy?.();
    this.host?.done?.(null);
  }
}

// ---- swatches (S7.2) ---------------------------------------------------------------------------------------------

const RANGES = {
  rgb: [[0, 255], [0, 255], [0, 255]],
  lab: [[0, 100], [-128, 127], [-128, 127]],
  cmyk: [[0, 100], [0, 100], [0, 100], [0, 100]],
  gray: [[0, 100]],
};
export const SWATCH_TYPES = ['global', 'spot', 'process'];

/** A `swatches` preset's data, normalised (values clamped to their ranges), or null. Keeps `type` and `book`. */
export function normalizeSwatchData(data) {
  if (!data || typeof data !== 'object' || !data.color || typeof data.color !== 'object') return null;
  const { space } = data.color;
  const ranges = RANGES[space];
  if (!ranges || !Array.isArray(data.color.values) || data.color.values.length < ranges.length) return null;
  const values = ranges.map(([lo, hi], i) => Number(data.color.values[i]));
  if (values.some((v) => !Number.isFinite(v))) return null;
  const out = { color: { space, values: values.map((v, i) => Math.round(clamp(v, ranges[i][0], ranges[i][1]) * 1e4) / 1e4) } };
  if (SWATCH_TYPES.includes(data.type) && data.type !== 'process') out.type = data.type;
  if (data.book && typeof data.book === 'object' && typeof data.book.book === 'string' && typeof data.book.name === 'string') out.book = { book: data.book.book, name: data.book.name };
  return out;
}

/** A swatch's data for an RGB hex (what "New Swatch" stores), or for a picked ColorValue (Lab, CMYK, books kept). */
export function swatchFromHex(hex) {
  return { color: { space: 'rgb', values: rgbOfHex(hex) } };
}

export function swatchFromColorValue(c) {
  if (!c) return null;
  if (c.space === 'book' && Array.isArray(c.lab)) return { color: { space: 'lab', values: c.lab.slice(0, 3) }, type: 'spot', ...(c.book ? { book: { ...c.book } } : {}) };
  if (c.space === 'book' && Array.isArray(c.cmyk)) return { color: { space: 'cmyk', values: c.cmyk.slice(0, 4) }, type: 'spot', ...(c.book ? { book: { ...c.book } } : {}) };
  if (c.space === 'lab' && Array.isArray(c.lab)) return { color: { space: 'lab', values: c.lab.slice(0, 3).map((v) => Math.round(v)) } };
  if (c.space === 'cmyk' && Array.isArray(c.cmyk)) return { color: { space: 'cmyk', values: c.cmyk.slice(0, 4).map((v) => Math.round(v)) } };
  return swatchFromHex(c.hex);
}

/**
 * 0.4's edited palette (settings.swatches: '#rrggbb' strings or { color, name }) as the presets that replace the
 * kind's built-ins, in order. Unreadable entries are dropped.
 */
export function migrateSwatchList(list) {
  const out = [];
  for (const e of Array.isArray(list) ? list : []) {
    const raw = typeof e === 'string' ? e : e && typeof e === 'object' ? e.color : null;
    if (typeof raw !== 'string' || !/^#?([0-9a-f]{3}|[0-9a-f]{6})([0-9a-f]{2})?$/i.test(raw.trim())) continue;
    const hex = hexOfRgb(rgbOfHex(raw.trim().startsWith('#') ? raw.trim() : `#${raw.trim()}`));
    const name = e && typeof e === 'object' && typeof e.name === 'string' && e.name.trim() ? e.name.trim() : hex;
    out.push({ name, data: swatchFromHex(hex) });
  }
  return out;
}

/** The presets matching a search: name, hex or book name, case-insensitive; '' matches all. */
export function filterSwatches(presets, query, hexOf) {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return presets.slice();
  const bare = q.replace(/^#/, '');
  return presets.filter((p) => {
    if (String(p.name ?? '').toLowerCase().includes(q)) return true;
    if (p.data?.book?.name && p.data.book.name.toLowerCase().includes(q)) return true;
    const hex = hexOf?.(p.data);
    return !!hex && bare.length >= 2 && /^[0-9a-f]+$/.test(bare) && hex.slice(1).includes(bare);
  });
}

// ---- colour books (.acb) -----------------------------------------------------------------------------------------

const ACB_SPACES = { 0: 'rgb', 2: 'cmyk', 7: 'lab' };
const ACB_CODES = { rgb: 0, cmyk: 2, lab: 7 };
export const MAX_BOOK_BYTES = 16 * 1024 * 1024;

/** "$$$/colorbook/ANPA/title=ANPA Color" → "ANPA Color"; ^R and ^C → ® and ©. */
export function acbText(s) {
  let t = String(s ?? '').replace(/\0+$/, '');
  if (t.startsWith('$$$/')) t = t.slice(t.indexOf('=') + 1);
  return t.replace(/\^R/g, '®').replace(/\^C/g, '©');
}

/**
 * An Adobe Color Book: { title, prefix, postfix, description, id, colorSpace, pageSize, colors: [{ name, code, color,
 * type }], report }. Never throws; a damaged file gives the colours read before the damage. The placeholder entries
 * books use to fill their pages (no name) are left out.
 */
export function parseAcb(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input ?? []);
  const report = [];
  const book = { title: '', prefix: '', postfix: '', description: '', id: 0, colorSpace: 'rgb', pageSize: 0, colors: [], report };
  if (bytes.length > MAX_BOOK_BYTES) {
    report.push('The colour book is larger than 16 MB');
    return book;
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 0;
  const need = (n) => {
    if (o + n > bytes.length) throw new RangeError('truncated');
  };
  const u16 = () => {
    need(2);
    const v = dv.getUint16(o);
    o += 2;
    return v;
  };
  const u32 = () => {
    need(4);
    const v = dv.getUint32(o);
    o += 4;
    return v;
  };
  const ustr = () => {
    const n = u32();
    if (n > 65535) throw new RangeError('string');
    need(n * 2);
    let s = '';
    for (let i = 0; i < n; i++) s += String.fromCharCode(dv.getUint16(o + i * 2));
    o += n * 2;
    return s;
  };
  try {
    need(4);
    if (String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) !== '8BCB') {
      report.push('This is not an Adobe Color Book (.acb) file');
      return book;
    }
    o = 4;
    const version = u16();
    if (version !== 1) report.push(`Colour book version ${version}: read as version 1`);
    book.id = u16();
    book.title = acbText(ustr());
    book.prefix = acbText(ustr());
    book.postfix = acbText(ustr());
    book.description = acbText(ustr());
    const count = u16();
    book.pageSize = u16();
    u16(); // page selector offset
    const code = u16();
    book.colorSpace = ACB_SPACES[code];
    if (!book.colorSpace) {
      report.push(`The colour book uses a colour space Pigment cannot read (${code})`);
      book.colorSpace = 'rgb';
      return book;
    }
    const n = book.colorSpace === 'cmyk' ? 4 : 3;
    const colors = book.colors; // filled as they are read: a damaged file keeps what came before the damage
    for (let i = 0; i < count; i++) {
      const name = acbText(ustr());
      need(6 + n);
      const codeText = String.fromCharCode(...bytes.subarray(o, o + 6)).trim();
      o += 6;
      const c = bytes.subarray(o, o + n);
      o += n;
      if (!name.trim() && !codeText) continue; // a page filler
      let values;
      if (book.colorSpace === 'rgb') values = [c[0], c[1], c[2]];
      else if (book.colorSpace === 'cmyk') values = [...c].map((v) => Math.round(((255 - v) / 2.55) * 100) / 100);
      else values = [Math.round((c[0] / 2.55) * 100) / 100, c[1] - 128, c[2] - 128];
      colors.push({ name: name.trim(), code: codeText, color: { space: book.colorSpace, values }, type: 'spot' });
    }
    // newer books end with "spflspot" or "spflproc"
    if (o + 8 <= bytes.length && String.fromCharCode(...bytes.subarray(o, o + 4)) === 'spfl') {
      const kind = String.fromCharCode(...bytes.subarray(o + 4, o + 8));
      if (kind === 'proc') for (const c of colors) c.type = 'process';
    }
  } catch {
    report.push(`The colour book is damaged: ${book.colors.length ? `read ${book.colors.length} colours before the damage` : 'no colours could be read'}`);
  }
  if (!book.title) book.title = 'Untitled Book';
  return book;
}

/** An .acb file for a book (the tests' fixtures; Export Book). Lab and CMYK are stored as the format's bytes. */
export function writeAcb({ title = '', prefix = '', postfix = '', description = '', id = 3000, colorSpace = 'rgb', pageSize = 7, colors = [], process = false } = {}) {
  const parts = [];
  const u16 = (v) => parts.push(new Uint8Array([(v >> 8) & 255, v & 255]));
  const u32 = (v) => parts.push(new Uint8Array([(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]));
  const ustr = (s) => {
    const t = String(s ?? '');
    u32(t.length);
    const b = new Uint8Array(t.length * 2);
    for (let i = 0; i < t.length; i++) {
      b[i * 2] = t.charCodeAt(i) >> 8;
      b[i * 2 + 1] = t.charCodeAt(i) & 255;
    }
    parts.push(b);
  };
  parts.push(new Uint8Array([56, 66, 67, 66])); // 8BCB
  u16(1);
  u16(id);
  ustr(title);
  ustr(prefix);
  ustr(postfix);
  ustr(description);
  u16(colors.length);
  u16(pageSize);
  u16(0);
  u16(ACB_CODES[colorSpace] ?? 0);
  for (const c of colors) {
    ustr(c.name);
    const code = String(c.code ?? '').padEnd(6, ' ').slice(0, 6);
    parts.push(new Uint8Array([...code].map((ch) => ch.charCodeAt(0) & 255)));
    const v = c.color?.values ?? [];
    if (colorSpace === 'cmyk') parts.push(new Uint8Array(v.slice(0, 4).map((x) => clamp(Math.round(255 - x * 2.55), 0, 255))));
    else if (colorSpace === 'lab') parts.push(new Uint8Array([clamp(Math.round(v[0] * 2.55), 0, 255), clamp(Math.round(v[1] + 128), 0, 255), clamp(Math.round(v[2] + 128), 0, 255)]));
    else parts.push(new Uint8Array(v.slice(0, 3).map((x) => clamp(Math.round(x), 0, 255))));
  }
  parts.push(new Uint8Array([...(process ? 'spflproc' : 'spflspot')].map((ch) => ch.charCodeAt(0))));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** A book from parseAse's result (Load Book… with an .ase file): its groups' colours in file order. */
export function bookFromAse(parsed, fileName = '') {
  const colors = (Array.isArray(parsed?.all) ? parsed.all : [...(parsed?.groups ?? []).flatMap((g) => g.colors ?? []), ...(parsed?.colors ?? [])])
    .filter((c) => c && c.color && RANGES[c.color.space])
    .map((c) => ({ name: String(c.name ?? '').trim(), code: '', color: { space: c.color.space, values: c.color.values.slice() }, type: c.type === 'process' ? 'process' : 'spot' }));
  const spaces = new Set(colors.map((c) => c.color.space));
  const title = String(fileName).replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '') || 'Untitled Book';
  return { title, prefix: '', postfix: '', description: '', id: 0, colorSpace: spaces.size === 1 ? [...spaces][0] : 'mixed', pageSize: 0, colors, report: [...(parsed?.report ?? [])] };
}

/** The name a book colour shows: "PANTONE 185 C" = prefix + name + postfix. */
export const bookColorName = (book, c) => `${book?.prefix ?? ''}${c?.name ?? ''}${book?.postfix ?? ''}`.trim();

/** The colours of a book whose name (with prefix and postfix) or code contains the query. */
export function filterBookColors(book, query) {
  const q = String(query ?? '').trim().toLowerCase();
  const all = Array.isArray(book?.colors) ? book.colors : [];
  if (!q) return all.slice();
  return all.filter((c) => bookColorName(book, c).toLowerCase().includes(q) || String(c.name).toLowerCase().includes(q) || String(c.code ?? '').toLowerCase().includes(q));
}

// ---- eyedropper -------------------------------------------------------------------------------------------------

/** Photoshop's Sample Size choices (value: the side of the averaged square). */
export const SAMPLE_SIZES = Object.freeze([
  ['1', 'Point Sample'],
  ['3', '3 by 3 Average'],
  ['5', '5 by 5 Average'],
  ['11', '11 by 11 Average'],
  ['31', '31 by 31 Average'],
  ['51', '51 by 51 Average'],
  ['101', '101 by 101 Average'],
]);

/** Photoshop's Sample choices. 'merged' and 'layer' are 0.4's values (All Layers, Current Layer). */
export const SAMPLE_SOURCES = Object.freeze([
  ['layer', 'Current Layer'],
  ['below', 'Current & Below'],
  ['merged', 'All Layers'],
  ['merged-no-adj', 'All Layers No Adjustments'],
  ['below-no-adj', 'Current & Below No Adjustments'],
]);

/**
 * What a Sample choice reads, for sampleMerged (S7.5): { layer: true } for the current layer's own pixels, else
 * { until, skipAdjustments } where `until` is the layer above the current one (null: every layer). `above(layer)`
 * gives that layer.
 */
export function sampleSourceOf(source, active, above) {
  if (source === 'layer') return { layer: true };
  const below = source === 'below' || source === 'below-no-adj';
  const until = below && active ? above(active) ?? null : null;
  return { layer: false, until, all: below && active && !until, skipAdjustments: source === 'merged-no-adj' || source === 'below-no-adj' };
}

/** The alpha-weighted average of RGBA bytes: [r, g, b, a 0..1], or null when every pixel is transparent. */
export function averageRgba(d) {
  let r = 0, g = 0, b = 0, a = 0, n = 0;
  for (let i = 0; i < d.length; i += 4) {
    const al = d[i + 3] / 255;
    r += d[i] * al;
    g += d[i + 1] * al;
    b += d[i + 2] * al;
    a += al;
    n++;
  }
  if (!n || a <= 0) return null;
  return [r / a, g / a, b / a, a / n];
}

/** Copy Color's Hex Code: "ff8800". */
export const hexCode = (hex) => hexOfRgb(rgbOfHex(hex)).slice(1);
/** Copy Color as HTML: COLOR="#ff8800", as Photoshop writes it. */
export const htmlCode = (hex) => `COLOR="${hexOfRgb(rgbOfHex(hex))}"`;
