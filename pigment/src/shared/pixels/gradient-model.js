// The gradient model of Pigment 0.4 (ARCHITECTURE.md "0.4 features", G.1). Pure, no DOM: shared by
// the renderer, styles.js (Gradient Overlay), the Gradient Map kind, deep.js and Node tests.
// Skeleton version, completed by the gradients package: the five interpolation methods (classic, perceptual = Oklab,
// linear = linear-light sRGB, smooth = a monotone cubic through the stops in Oklab, stripes = no blend) and seeded
// noise gradients. The per-pixel renderer of these is gradient-render.js (same file family, same results).
//
// A GradientDef is { gradientVersion: 2, type, interpolation, smoothness, stops, opacityStops,
// noise? }: colour stops { pos, mid, color: '#rrggbb' | { ref: 'fg' | 'bg' } } and opacity stops
// { pos, mid, opacity } are interpolated separately. Placement (kind, angle, scale, offset, align,
// reverse, dither, from, to) is not part of the def: it sits next to it (flat on fill-layer
// paints, tool options and effect objects) and normalizeGradient() carries it through untouched.
//
// Every 0.3 shape upgrades lazily through normalizeGradient(): the Gradient tool's and fill
// layers' { kind, stops: [{ pos, color (#rrggbb or #rrggbbaa) }], from, to, reverse }, Gradient
// Map's { stops: [{ offset | position | pos, color } | [offset, color]], reverse } and Gradient
// Overlay's { stops: [{ pos, color, opacity? }], kind, angle, scale, reverse }. Each old stop gives
// a colour stop (mid 0.5) and an opacity stop at the same place (alpha x opacity), with
// interpolation 'classic' and smoothness 0, which is exactly 0.3's linear interpolation.
//
// Midpoints: the `mid` of a stop bends the segment that ends at that stop (the segment from the
// previous stop to this one), as Photoshop's gradient files store it; the first stop's mid is
// unused.

import { parseColor, hsvToRgb, labToRgb } from './color.js';

/** @typedef {{ pos: number, mid: number, color: string | { ref: 'fg' | 'bg' } }} ColorStop */
/** @typedef {{ pos: number, mid: number, opacity: number }} OpacityStop */

export const INTERPOLATIONS = Object.freeze(['classic', 'perceptual', 'linear', 'smooth', 'stripes']);
export const GRADIENT_KINDS = Object.freeze(['linear', 'radial', 'angle', 'reflected', 'diamond', 'shape-burst']);
/** Placement fields: carried through normalizeGradient() as they are (G.1 GradientPlacement). */
export const PLACEMENT_KEYS = Object.freeze(['kind', 'angle', 'scale', 'offset', 'align', 'reverse', 'dither', 'from', 'to']);

const NOISE_DEFAULTS = Object.freeze({
  roughness: 0.5, model: 'rgb', min: Object.freeze([0, 0, 0]), max: Object.freeze([1, 1, 1]),
  restrict: false, transparency: false, seed: 1,
});

function freezeDeep(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) freezeDeep(v);
  }
  return o;
}

/** Photoshop's new gradient: black to white, perceptual, smoothness 100 %. */
export const GRADIENT_DEFAULTS = freezeDeep({
  gradientVersion: 2,
  type: 'solid',
  interpolation: 'perceptual',
  smoothness: 1,
  stops: [{ pos: 0, mid: 0.5, color: '#000000' }, { pos: 1, mid: 0.5, color: '#ffffff' }],
  opacityStops: [{ pos: 0, mid: 0.5, opacity: 1 }, { pos: 1, mid: 0.5, opacity: 1 }],
});

const num = (v, def) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : def;
};
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const clamp01 = (v) => clamp(v, 0, 1);
const hex2 = (v) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0');
const toHex = (rgba) => `#${hex2(rgba[0])}${hex2(rgba[1])}${hex2(rgba[2])}`;

/** True for a version 2 gradient def. */
export function isGradientV2(g) {
  return !!g && typeof g === 'object' && g.gradientVersion === 2;
}

const isRef = (c) => !!c && typeof c === 'object' && !Array.isArray(c) && (c.ref === 'fg' || c.ref === 'bg');

/** fg / bg as [r, g, b, a]; without colours fg is black and bg white (G.1). */
function refColor(ref, opts) {
  const c = ref === 'fg' ? opts?.fg : opts?.bg;
  if (c !== undefined && c !== null) return parseColor(c, ref === 'fg' ? [0, 0, 0, 1] : [255, 255, 255, 1]);
  return ref === 'fg' ? [0, 0, 0, 1] : [255, 255, 255, 1];
}

function sortStable(list) {
  return list.map((s, i) => [s, i]).sort((a, b) => a[0].pos - b[0].pos || a[1] - b[1]).map((e) => e[0]);
}

/** One 0.3 stop -> its position, rgba (alpha included) and the 0.3 overlay opacity. */
function legacyStop(s) {
  if (Array.isArray(s)) return { pos: num(s[0], NaN), color: s[1], opacity: 1 };
  if (!s || typeof s !== 'object') return null;
  return { pos: num(s.pos ?? s.offset ?? s.position, NaN), color: s.color, opacity: s.opacity === undefined ? 1 : clamp01(num(s.opacity, 1)) };
}

function upgradeLegacy(g, opts) {
  let raw = g.stops;
  // 0.3 tool presets name two stop sets by string
  if (raw === 'fgbg') raw = [{ pos: 0, color: { ref: 'fg' } }, { pos: 1, color: { ref: 'bg' } }];
  else if (raw === 'fgt') raw = [{ pos: 0, color: { ref: 'fg' } }, { pos: 1, color: { ref: 'fg' }, opacity: 0 }];
  const stops = [], opacityStops = [];
  for (const s of Array.isArray(raw) ? raw : []) {
    const l = legacyStop(s);
    if (!l || !Number.isFinite(l.pos)) continue;
    const pos = clamp01(l.pos);
    let rgba, color;
    if (isRef(l.color)) {
      rgba = [0, 0, 0, 1];
      color = opts.keepRefs ? { ref: l.color.ref } : toHex(refColor(l.color.ref, opts));
    } else {
      rgba = parseColor(l.color, [0, 0, 0, 1]);
      color = toHex(rgba);
    }
    stops.push({ pos, mid: 0.5, color });
    opacityStops.push({ pos, mid: 0.5, opacity: clamp01(num(rgba[3], 1)) * l.opacity });
  }
  if (!stops.length) {
    stops.push({ pos: 0, mid: 0.5, color: '#000000' }, { pos: 1, mid: 0.5, color: '#ffffff' });
    opacityStops.push({ pos: 0, mid: 0.5, opacity: 1 }, { pos: 1, mid: 0.5, opacity: 1 });
  }
  return { gradientVersion: 2, type: 'solid', interpolation: 'classic', smoothness: 0, stops: sortStable(stops), opacityStops: sortStable(opacityStops) };
}

function cleanColor(c, opts) {
  if (isRef(c)) return opts.keepRefs ? { ref: c.ref } : toHex(refColor(c.ref, opts));
  return toHex(parseColor(c, [0, 0, 0, 1]));
}

function cleanV2(g, opts) {
  const stops = [];
  for (const s of Array.isArray(g.stops) ? g.stops : []) {
    if (!s || typeof s !== 'object') continue;
    const pos = num(s.pos, NaN);
    if (!Number.isFinite(pos)) continue;
    stops.push({ pos: clamp01(pos), mid: clamp(num(s.mid, 0.5), 0.05, 0.95), color: cleanColor(s.color, opts) });
  }
  const opacityStops = [];
  for (const s of Array.isArray(g.opacityStops) ? g.opacityStops : []) {
    if (!s || typeof s !== 'object') continue;
    const pos = num(s.pos, NaN);
    if (!Number.isFinite(pos)) continue;
    opacityStops.push({ pos: clamp01(pos), mid: clamp(num(s.mid, 0.5), 0.05, 0.95), opacity: clamp01(num(s.opacity, 1)) });
  }
  const out = {
    gradientVersion: 2,
    type: g.type === 'noise' ? 'noise' : 'solid',
    interpolation: INTERPOLATIONS.includes(g.interpolation) ? g.interpolation : GRADIENT_DEFAULTS.interpolation,
    smoothness: clamp01(num(g.smoothness, GRADIENT_DEFAULTS.smoothness)),
    stops: stops.length ? sortStable(stops) : GRADIENT_DEFAULTS.stops.map((s) => ({ ...s })),
    opacityStops: opacityStops.length ? sortStable(opacityStops) : GRADIENT_DEFAULTS.opacityStops.map((s) => ({ ...s })),
  };
  if ((g.noise && typeof g.noise === 'object') || out.type === 'noise') {
    const n = g.noise && typeof g.noise === 'object' ? g.noise : {};
    const triple = (v, def) => (Array.isArray(v) && v.length >= 3 ? [0, 1, 2].map((i) => clamp01(num(v[i], def[i]))) : [...def]);
    out.noise = {
      roughness: clamp01(num(n.roughness, NOISE_DEFAULTS.roughness)),
      model: n.model === 'hsb' || n.model === 'lab' ? n.model : 'rgb',
      min: triple(n.min, NOISE_DEFAULTS.min),
      max: triple(n.max, NOISE_DEFAULTS.max),
      restrict: !!n.restrict,
      transparency: !!n.transparency,
      seed: Math.trunc(num(n.seed, NOISE_DEFAULTS.seed)),
    };
  }
  return out;
}

/**
 * Any gradient (every 0.3 shape and v2) as a clean v2 def. Never throws. With { fg, bg } every
 * { ref } stop becomes #rrggbb; without them fg reads as #000000 and bg as #ffffff. The placement
 * fields of the input (PLACEMENT_KEYS) are copied onto the result as they are, so a fill layer's
 * flat `GradientDef & GradientPlacement` stays one object.
 * `keepRefs: true` (an addition for preset data, the one place refs may be stored) keeps the refs.
 * @param {any} g
 * @param {{ fg?: any, bg?: any, keepRefs?: boolean }} [opts]
 */
export function normalizeGradient(g, opts = {}) {
  const o = opts || {};
  let def;
  try {
    if (!g || typeof g !== 'object') def = cleanV2(GRADIENT_DEFAULTS, o);
    else def = isGradientV2(g) ? cleanV2(g, o) : upgradeLegacy(g, o);
    if (g && typeof g === 'object') {
      for (const k of PLACEMENT_KEYS) {
        if (g[k] === undefined) continue;
        def[k] = Array.isArray(g[k]) ? [...g[k]] : g[k];
      }
    }
  } catch {
    def = cleanV2(GRADIENT_DEFAULTS, o);
  }
  return def;
}

/** The interpolation parameter of a segment after its midpoint and smoothness (classic). */
function bend(u, mid, smoothness) {
  let v = mid === 0.5 ? u : Math.pow(u, Math.log(0.5) / Math.log(mid));
  if (smoothness > 0) v += (v * v * (3 - 2 * v) - v) * smoothness;
  return v;
}

/** The segment of t in a sorted stop list: [index of its first stop, f (0..1, unbent)], 0.3's search (styles.js). */
function locate(list, t) {
  const last = list.length - 1;
  if (t <= list[0].pos) return [0, -1];
  if (t >= list[last].pos) return [last, -1];
  let k = 0;
  while (k < last - 1 && list[k + 1].pos < t) k++;
  const s0 = list[k], s1 = list[k + 1];
  return [k, s1.pos > s0.pos ? (t - s0.pos) / (s1.pos - s0.pos) : 1];
}

/** Finds the segment of t in a sorted stop list: [s0, s1, f], f bent by the midpoint and smoothness (classic). */
function segment(list, t, smoothness) {
  const [k, f] = locate(list, t);
  if (f < 0) return [list[k], list[k], 0];
  const s1 = list[k + 1];
  return [list[k], s1, bend(f, s1.mid ?? 0.5, smoothness)];
}

// ---- colour spaces of the interpolation methods ---------------------------------------------------------------------
// 'linear' mixes linear-light sRGB; 'perceptual' and 'smooth' mix Oklab (Björn Ottosson's perceptual space).

const toLin = (c) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const fromLin = (v) => 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v < 0 ? 0 : v, 1 / 2.4) - 0.055);

/** sRGB 0..255 -> Oklab [L, a, b]. */
export function rgbToOklab(r, g, b) {
  const R = toLin(r), G = toLin(g), B = toLin(b);
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** Oklab -> sRGB 0..255 (unrounded, clamped to the gamut by channel). */
export function oklabToRgb(L, a, b) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const R = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const G = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const B = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
  return [clamp(fromLin(R), 0, 255), clamp(fromLin(G), 0, 255), clamp(fromLin(B), 0, 255)];
}

/**
 * Monotone cubic (Fritsch-Carlson) tangents of the values ys at the positions xs: the 'smooth' method passes through
 * every stop without overshooting and without the kink of a straight-line join.
 */
function monotoneTangents(xs, ys) {
  const n = xs.length;
  const m = new Array(n).fill(0);
  if (n < 2) return m;
  const d = [];
  for (let i = 0; i < n - 1; i++) {
    const h = xs[i + 1] - xs[i];
    d.push(h > 1e-9 ? (ys[i + 1] - ys[i]) / h : 0);
  }
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      m[i] = m[i + 1] = 0;
      continue;
    }
    const a = m[i] / d[i], b = m[i + 1] / d[i];
    const r = a * a + b * b;
    if (r > 9) {
      const tau = 3 / Math.sqrt(r);
      m[i] = tau * a * d[i];
      m[i + 1] = tau * b * d[i];
    }
  }
  return m;
}

/** Cubic Hermite between y0 and y1 (tangents m0, m1 per unit of position, segment length h) at u. */
function hermite(y0, y1, m0, m1, h, u) {
  const u2 = u * u, u3 = u2 * u;
  return (2 * u3 - 3 * u2 + 1) * y0 + (u3 - 2 * u2 + u) * h * m0 + (-2 * u3 + 3 * u2) * y1 + (u3 - u2) * h * m1;
}

// ---- noise gradients ------------------------------------------------------------------------------------------------
// A noise gradient is a deterministic function of its settings: the same seed gives the same gradient everywhere
// (files, presets, 8 and 16/32 bits). Each channel of the colour model (and the alpha with Add Transparency) is a
// random walk over a number of knots that grows with the roughness, kept inside the channel's [min, max] range and
// joined by straight lines; Restrict Colors pulls the saturation of the result back under 85 %.

/** mulberry32: a small, fast, seedable generator (deterministic per 32-bit seed). */
export function seededRandom(seed) {
  let a = (Math.trunc(seed) | 0) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The knots of a noise gradient: { n, ch: Float64Array[4] } (three colour channels and alpha, each 0..1). */
function noiseKnots(noise) {
  const rough = noise.roughness;
  const n = 3 + Math.round(rough * 61);
  const step = 0.12 + 0.88 * rough;
  const rand = seededRandom(noise.seed);
  const ch = [];
  for (let c = 0; c < 4; c++) {
    const k = new Float64Array(n);
    let v = rand();
    for (let i = 0; i < n; i++) {
      if (i) {
        v += (rand() * 2 - 1) * step;
        // reflect at the edges so the walk keeps moving instead of sticking to 0 or 1
        if (v < 0) v = -v;
        if (v > 1) v = 2 - v;
        v = clamp01(v);
      }
      k[i] = v;
    }
    ch.push(k);
  }
  return { n, ch };
}

function noiseSample(p, t) {
  const n = p.noise;
  const { n: count, ch } = p._knots;
  const x = clamp01(t) * (count - 1);
  const i = Math.min(count - 2, Math.floor(x));
  const f = x - i;
  const at = (c) => ch[c][i] + (ch[c][i + 1] - ch[c][i]) * f;
  const v = [0, 1, 2].map((c) => n.min[c] + (n.max[c] - n.min[c]) * at(c));
  let rgb;
  if (n.model === 'hsb') rgb = hsvToRgb(v[0] * 360, v[1], v[2]);
  else if (n.model === 'lab') rgb = labToRgb(v[0] * 100, v[1] * 255 - 128, v[2] * 255 - 128);
  else rgb = [v[0] * 255, v[1] * 255, v[2] * 255];
  if (n.restrict) {
    // keep the saturation under 85 % (Photoshop's Restrict Colors prevents oversaturated colours)
    const max = Math.max(rgb[0], rgb[1], rgb[2]), min = Math.min(rgb[0], rgb[1], rgb[2]);
    const s = max > 0 ? (max - min) / max : 0;
    if (s > 0.85) {
      const k = 0.85 / s;
      rgb = rgb.map((c) => max - (max - c) * k);
    }
  }
  const alpha = n.transparency ? at(3) : 1;
  return [rgb[0], rgb[1], rgb[2], alpha];
}

function stopRgb(stop, opts) {
  if (stop._rgb) return stop._rgb;
  return isRef(stop.color) ? refColor(stop.color.ref, opts) : parseColor(stop.color, [0, 0, 0, 1]);
}

/** Prepared def: normalised, stop colours parsed once, the method's colour space and noise knots precomputed. */
function prepare(def, opts) {
  const d = isGradientV2(def) && def._prepared ? def : normalizeGradient(def, { fg: opts?.fg, bg: opts?.bg });
  if (d._prepared) return d;
  const stops = d.stops.map((s) => {
    const rgb = stopRgb(s, opts);
    return { ...s, _rgb: rgb, _lin: [toLin(rgb[0]), toLin(rgb[1]), toLin(rgb[2])], _lab: rgbToOklab(rgb[0], rgb[1], rgb[2]) };
  });
  const p = { ...d, stops, _prepared: true };
  if (d.interpolation === 'smooth') {
    const xs = stops.map((s) => s.pos);
    p._tan = [0, 1, 2].map((c) => monotoneTangents(xs, stops.map((s) => s._lab[c])));
    p._otan = monotoneTangents(d.opacityStops.map((s) => s.pos), d.opacityStops.map((s) => s.opacity));
  }
  if (d.type === 'noise') {
    p.noise = d.noise ?? { ...NOISE_DEFAULTS, min: [...NOISE_DEFAULTS.min], max: [...NOISE_DEFAULTS.max] };
    p._knots = noiseKnots(p.noise);
  }
  return p;
}

/** The colour of a solid def at t for its interpolation method: [r, g, b] 0..255, unrounded. */
function solidRgb(p, t) {
  const method = p.interpolation;
  const list = p.stops;
  if (method === 'classic') {
    const [c0, c1, f] = segment(list, t, p.smoothness);
    const a = c0._rgb, b = c1._rgb;
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
  }
  const [k, f] = locate(list, t);
  if (f < 0) return list[k]._rgb.slice(0, 3);
  const s0 = list[k], s1 = list[k + 1];
  const mid = s1.mid ?? 0.5;
  if (method === 'stripes') return (f < mid ? s0 : s1)._rgb.slice(0, 3);
  const u = bend(f, mid, 0);
  if (method === 'linear') {
    const a = s0._lin, b = s1._lin;
    return [fromLin(a[0] + (b[0] - a[0]) * u), fromLin(a[1] + (b[1] - a[1]) * u), fromLin(a[2] + (b[2] - a[2]) * u)].map((v) => clamp(v, 0, 255));
  }
  const a = s0._lab, b = s1._lab;
  if (method === 'smooth') {
    const h = s1.pos - s0.pos;
    const L = [0, 1, 2].map((c) => hermite(a[c], b[c], p._tan[c][k], p._tan[c][k + 1], h, u));
    return oklabToRgb(L[0], L[1], L[2]);
  }
  return oklabToRgb(a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u);
}

/** The opacity (0..1) of a def at t for its interpolation method. */
function solidAlpha(p, t) {
  const list = p.opacityStops;
  const method = p.interpolation;
  if (method === 'classic') {
    const [o0, o1, g] = segment(list, t, p.smoothness);
    return o0.opacity + (o1.opacity - o0.opacity) * g;
  }
  const [k, f] = locate(list, t);
  if (f < 0) return list[k].opacity;
  const s0 = list[k], s1 = list[k + 1];
  const mid = s1.mid ?? 0.5;
  if (method === 'stripes') return (f < mid ? s0 : s1).opacity;
  const u = bend(f, mid, 0);
  if (method === 'smooth') return clamp01(hermite(s0.opacity, s1.opacity, p._otan[k], p._otan[k + 1], s1.pos - s0.pos, u));
  return s0.opacity + (s1.opacity - s0.opacity) * u;
}

function sampleWith(p, t) {
  t = clamp01(Number.isFinite(t) ? t : 0);
  if (p.type === 'noise') return noiseSample(p, t);
  const rgb = solidRgb(p, t);
  return [rgb[0], rgb[1], rgb[2], solidAlpha(p, t)];
}

/**
 * The reference sampler: colour at t (0..1) as [r, g, b (0..255, unrounded), a (0..1)].
 * @param {any} def any gradient shape
 * @param {number} t
 * @param {{ fg?: any, bg?: any }} [opts]
 */
export function sampleGradient(def, t, opts = {}) {
  return sampleWith(prepare(def, opts), t);
}

/**
 * sampleGradient with the def prepared once: (t) -> [r, g, b (0..255, unrounded), a (0..1)]. For callers that sample
 * many times (deep.js evaluates Gradient Map per 16/32-bit sample).
 * @param {any} def
 * @param {{ fg?: any, bg?: any }} [opts]
 */
export function gradientSampler(def, opts = {}) {
  const p = prepare(def, opts);
  return (t) => sampleWith(p, t);
}

/**
 * Straight RGBA lookup table of `size` entries (entry i is t = i / (size - 1); reversed with
 * `reverse`). Stored in a Uint8ClampedArray like 0.3's styles.js table.
 * @param {any} def
 * @param {{ fg?: any, bg?: any, reverse?: boolean, size?: number }} [opts]
 * @returns {Uint8ClampedArray}
 */
export function gradientLut(def, opts = {}) {
  const o = opts || {};
  const size = Math.max(2, Math.floor(num(o.size, 1024)));
  const p = prepare(def, o);
  const lut = new Uint8ClampedArray(size * 4);
  for (let i = 0; i < size; i++) {
    let t = i / (size - 1);
    if (o.reverse) t = 1 - t;
    const c = sampleWith(p, t);
    const q = i * 4;
    lut[q] = c[0];
    lut[q + 1] = c[1];
    lut[q + 2] = c[2];
    lut[q + 3] = c[3] * 255;
  }
  return lut;
}

/**
 * The gradient parameter t of the point (x, y) for a placement (reference geometry; renderers
 * inline it). Not reversed (reverse is the LUT's) and not clamped, except that 'angle' wraps to
 * 0..1.
 *  - With `from` / `to` (fill layers, the Gradient tool; document coordinates, y down): 0.3's
 *    Canvas geometry: linear and reflected project onto from -> to, radial and diamond measure
 *    from `from` in units of |to - from| (diamond in L1 in the drag frame), angle is clockwise
 *    from the direction of `to`.
 *  - Otherwise (Gradient Overlay): 0.3's overlay geometry around the box centre (moved by
 *    `offset`, percent of the box), `angle` degrees counter-clockwise from 3 o'clock, `scale` a
 *    fraction: linear spans the box along the angle, radial and diamond reach half the box's
 *    larger side.
 * 'shape-burst' needs the layer's distance field and is not a function of the point: it reads 0.
 * @param {object} placement
 * @param {number} x
 * @param {number} y
 * @param {{ x: number, y: number, width: number, height: number }} box
 */
export function gradientT(placement, x, y, box) {
  const pl = placement || {};
  const kind = GRADIENT_KINDS.includes(pl.kind) ? pl.kind : 'linear';
  if (kind === 'shape-burst') return 0;
  if (Array.isArray(pl.from) && Array.isArray(pl.to)) {
    const fx = num(pl.from[0], 0), fy = num(pl.from[1], 0);
    const dx = num(pl.to[0], 0) - fx, dy = num(pl.to[1], 0) - fy;
    const len = Math.hypot(dx, dy) || 1;
    const px = x - fx, py = y - fy;
    if (kind === 'linear') return (px * dx + py * dy) / (len * len);
    if (kind === 'reflected') return Math.abs(px * dx + py * dy) / (len * len);
    if (kind === 'radial') return Math.hypot(px, py) / len;
    if (kind === 'diamond') {
      const ux = dx / len, uy = dy / len;
      return (Math.abs(px * ux + py * uy) + Math.abs(-px * uy + py * ux)) / len;
    }
    const t = (Math.atan2(py, px) - Math.atan2(dy, dx)) / (Math.PI * 2);
    return t - Math.floor(t);
  }
  const b = box || { x: 0, y: 0, width: 1, height: 1 };
  const off = Array.isArray(pl.offset) ? pl.offset : [0, 0];
  const cx = b.x + b.width / 2 + (num(off[0], 0) / 100) * b.width;
  const cy = b.y + b.height / 2 + (num(off[1], 0) / 100) * b.height;
  const a = (num(pl.angle, 90) * Math.PI) / 180;
  const ux = Math.cos(a), uy = -Math.sin(a);
  const vx = -uy, vy = ux;
  const scale = Math.max(0.01, num(pl.scale, 1));
  const len = Math.max(1e-6, (Math.abs(b.width * ux) + Math.abs(b.height * uy)) * scale);
  const rad = Math.max(1e-6, (Math.max(b.width, b.height) / 2) * scale);
  const px = x - cx, py = y - cy;
  if (kind === 'linear') return 0.5 + (px * ux + py * uy) / len;
  if (kind === 'reflected') return Math.abs(px * ux + py * uy) / (len / 2);
  if (kind === 'radial') return Math.hypot(px, py) / rad;
  if (kind === 'diamond') return (Math.abs(px * ux + py * uy) + Math.abs(px * vx + py * vy)) / rad;
  const t = (Math.atan2(-py, px) - a) / (Math.PI * 2);
  return t - Math.floor(t);
}
