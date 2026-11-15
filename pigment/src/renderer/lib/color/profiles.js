// ICC profiles in plain JavaScript (icc-engine, ARCHITECTURE.md "0.5 features", package 4; S6.1): the reader that
// names a profile and finds its colorants and tone curves, the writer of Pigment's generated profiles (sRGB, Display
// P3, Adobe RGB (1998)-compatible, ProPhoto-compatible, Gray Gamma 2.2) and the ColorProfile records of S6.1.
//
// LittleCMS (lib/color/lcms.js) does the colour maths; this file is what has to work without it: parse() is
// synchronous and must answer before the wasm is compiled (a .pigment opened at launch, the fake-free sync calls of
// S6.1), and the generated profiles are the bytes Pigment embeds in the files it saves, so they are written here,
// deterministically (a fixed date, no profile ID), and their SHA-1 never changes. Node-safe: no DOM.

// ---- bytes -----------------------------------------------------------------------------------------------------------

const u16 = (b, o) => (b[o] << 8) | b[o + 1];
const u32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const s15 = (b, o) => (u32(b, o) | 0) / 65536;
const sig = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);

/** SHA-1 of `bytes` as 40 hex digits (synchronous: ColorProfile ids are needed by the sync calls of S6.1). */
export function sha1Hex(bytes) {
  const len = bytes.length;
  const words = new Uint32Array((((len + 8) >> 6) + 1) * 16);
  for (let i = 0; i < len; i++) words[i >> 2] |= bytes[i] << (24 - (i & 3) * 8);
  words[len >> 2] |= 0x80 << (24 - (len & 3) * 8);
  words[words.length - 1] = len * 8; // files under 512 MB: the high word stays 0
  words[words.length - 2] = Math.floor((len * 8) / 0x100000000);
  let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
  const w = new Uint32Array(80);
  for (let blk = 0; blk < words.length; blk += 16) {
    for (let t = 0; t < 16; t++) w[t] = words[blk + t];
    for (let t = 16; t < 80; t++) {
      const x = w[t - 3] ^ w[t - 8] ^ w[t - 14] ^ w[t - 16];
      w[t] = (x << 1) | (x >>> 31);
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let t = 0; t < 80; t++) {
      let f, k;
      if (t < 20) (f = (b & c) | (~b & d)), (k = 0x5a827999);
      else if (t < 40) (f = b ^ c ^ d), (k = 0x6ed9eba1);
      else if (t < 60) (f = (b & c) | (b & d) | (c & d)), (k = 0x8f1bbcdc);
      else (f = b ^ c ^ d), (k = 0xca62c1d6);
      const tmp = (((a << 5) | (a >>> 27)) + f + e + k + w[t]) >>> 0;
      e = d;
      d = c;
      c = (b << 30) | (b >>> 2);
      b = a;
      a = tmp;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }
  return [h0, h1, h2, h3, h4].map((v) => (v >>> 0).toString(16).padStart(8, '0')).join('');
}

// ---- tone curves -----------------------------------------------------------------------------------------------------

/**
 * A tone curve as read from a profile: { kind: 'gamma', g } | { kind: 'para', type, p: number[] } | { kind: 'table',
 * t: Float64Array (0..1) } | { kind: 'identity' }. evalCurve maps device 0..1 to linear 0..1.
 */
export function evalCurve(c, x) {
  if (x <= 0) x = 0;
  else if (x >= 1) x = 1;
  switch (c?.kind) {
    case 'gamma':
      return Math.pow(x, c.g);
    case 'para': {
      const [g, a = 1, b = 0, cc = 0, d = 0, e = 0, f = 0] = c.p;
      let y;
      switch (c.type) {
        case 0:
          y = Math.pow(x, g);
          break;
        case 1:
          y = x >= -b / a ? Math.pow(a * x + b, g) : 0;
          break;
        case 2:
          y = x >= -b / a ? Math.pow(a * x + b, g) + cc : cc;
          break;
        case 3:
          y = x >= d ? Math.pow(a * x + b, g) : cc * x;
          break;
        case 4:
          y = x >= d ? Math.pow(a * x + b, g) + e : cc * x + f;
          break;
        default:
          y = x;
      }
      return Number.isFinite(y) ? Math.min(1, Math.max(0, y)) : 0;
    }
    case 'table': {
      const t = c.t;
      const n = t.length;
      if (n === 1) return t[0];
      const p = x * (n - 1);
      const i = Math.min(n - 2, Math.floor(p));
      return t[i] + (t[i + 1] - t[i]) * (p - i);
    }
    default:
      return x;
  }
}

/** The inverse of a monotonic curve (linear 0..1 to device 0..1), by bisection: exact enough for table building. */
export function invertCurve(c, y) {
  if (c?.kind === 'gamma') return y <= 0 ? 0 : y >= 1 ? 1 : Math.pow(y, 1 / c.g);
  if (!c || c.kind === 'identity') return Math.min(1, Math.max(0, y));
  let lo = 0, hi = 1;
  const rising = evalCurve(c, 1) >= evalCurve(c, 0);
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    const v = evalCurve(c, mid);
    if (rising ? v < y : v > y) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

function readCurve(b, o, size) {
  if (size < 12) return null;
  const type = sig(b, o);
  if (type === 'curv') {
    const n = u32(b, o + 8);
    if (12 + n * 2 > size) return null;
    if (n === 0) return { kind: 'identity' };
    if (n === 1) return { kind: 'gamma', g: u16(b, o + 12) / 256 };
    const t = new Float64Array(n);
    for (let i = 0; i < n; i++) t[i] = u16(b, o + 12 + i * 2) / 65535;
    return { kind: 'table', t };
  }
  if (type === 'para') {
    const fn = u16(b, o + 8);
    const count = [1, 3, 4, 5, 7][fn];
    if (count === undefined || 12 + count * 4 > size) return null;
    const p = [];
    for (let i = 0; i < count; i++) p.push(s15(b, o + 12 + i * 4));
    if (fn === 0) return { kind: 'gamma', g: p[0] };
    return { kind: 'para', type: fn, p };
  }
  return null;
}

// ---- reading -------------------------------------------------------------------------------------------------------

const SPACES = { 'RGB ': 'rgb', GRAY: 'gray', CMYK: 'cmyk', 'Lab ': 'lab' };

function readText(b, o, size) {
  if (size < 12) return '';
  const type = sig(b, o);
  try {
    if (type === 'desc') {
      const n = u32(b, o + 8);
      let s = '';
      for (let i = 0; i < n && 12 + i < size; i++) {
        const ch = b[o + 12 + i];
        if (!ch) break;
        s += String.fromCharCode(ch);
      }
      return s.trim();
    }
    if (type === 'mluc') {
      const count = u32(b, o + 8);
      const rec = u32(b, o + 12);
      let pick = -1;
      for (let i = 0; i < count; i++) {
        const r = o + 16 + i * rec;
        if (r + 12 > o + size) break;
        const lang = String.fromCharCode(b[r], b[r + 1]);
        if (pick < 0 || lang === 'en') pick = r;
        if (lang === 'en') break;
      }
      if (pick < 0) return '';
      const len = u32(b, pick + 4);
      const off = u32(b, pick + 8);
      if (off + len > size) return '';
      let s = '';
      for (let i = 0; i + 1 < len; i += 2) {
        const ch = u16(b, o + off + i);
        if (!ch) break;
        s += String.fromCharCode(ch);
      }
      return s.trim();
    }
    if (type === 'text') {
      let s = '';
      for (let i = 8; i < size; i++) {
        const ch = b[o + i];
        if (!ch) break;
        s += String.fromCharCode(ch);
      }
      return s.trim();
    }
  } catch {}
  return '';
}

/**
 * Reads an ICC profile's header and the tags Pigment uses. Returns null for bytes that are not a profile (no 'acsp', a
 * size or tag table that runs past the end). The result: { version, deviceClass, space ('rgb' | 'gray' | 'cmyk' |
 * 'lab' | null), spaceSig, pcs, name, copyright, intent, wtpt, chad, matrix: { r, g, b } (D50 XYZ columns) | null,
 * curves: [r, g, b] | [k] | null, lut: true when the profile has A2B/B2A tables (LittleCMS reads those; the JS fast
 * paths do not) }.
 */
export function parseIcc(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : bytes ? new Uint8Array(bytes) : null;
  if (!b || b.length < 132 || sig(b, 36) !== 'acsp') return null;
  const size = u32(b, 0);
  if (size < 132 || size > b.length) return null;
  const count = u32(b, 128);
  if (count > 200 || 132 + count * 12 > size) return null;
  const tags = new Map();
  for (let i = 0; i < count; i++) {
    const at = 132 + i * 12;
    const off = u32(b, at + 4);
    const len = u32(b, at + 8);
    if (off + len > size || len < 8) continue;
    tags.set(sig(b, at), { off, len });
  }
  const tag = (s) => tags.get(s) ?? null;
  const xyz = (s) => {
    const t = tag(s);
    return t && t.len >= 20 && sig(b, t.off) === 'XYZ ' ? [s15(b, t.off + 8), s15(b, t.off + 12), s15(b, t.off + 16)] : null;
  };
  const curve = (s) => {
    const t = tag(s);
    return t ? readCurve(b, t.off, t.len) : null;
  };
  const text = (s) => {
    const t = tag(s);
    return t ? readText(b, t.off, t.len) : '';
  };
  const spaceSig = sig(b, 16);
  const space = SPACES[spaceSig] ?? null;
  const out = {
    version: `${b[8]}.${b[9] >> 4}`,
    major: b[8],
    deviceClass: sig(b, 12),
    space,
    spaceSig,
    pcs: sig(b, 20),
    name: text('desc') || text('dscm'),
    copyright: text('cprt'),
    intent: u32(b, 64) & 3,
    wtpt: xyz('wtpt'),
    chad: null,
    matrix: null,
    curves: null,
    lut: tags.has('A2B0') || tags.has('B2A0') || tags.has('A2B1') || tags.has('A2B2'),
  };
  const chad = tag('chad');
  if (chad && chad.len >= 44 && sig(b, chad.off) === 'sf32') out.chad = Array.from({ length: 9 }, (_, i) => s15(b, chad.off + 8 + i * 4));
  if (space === 'rgb') {
    const r = xyz('rXYZ'), g = xyz('gXYZ'), bl = xyz('bXYZ');
    const cr = curve('rTRC'), cg = curve('gTRC'), cb = curve('bTRC');
    if (r && g && bl && cr && cg && cb) {
      out.matrix = { r, g, b: bl };
      out.curves = [cr, cg, cb];
    }
  } else if (space === 'gray') {
    const k = curve('kTRC');
    if (k) out.curves = [k];
  }
  return out;
}

// ---- writing ---------------------------------------------------------------------------------------------------------

const D50 = [0.9642, 1, 0.8249];

const xyToXYZ = ([x, y]) => [x / y, 1, (1 - x - y) / y];

function mul3(m, v) {
  return [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
}
function mulM(a, b) {
  const o = new Array(9);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) o[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
  return o;
}
/** The inverse of a 3x3 row-major matrix. */
export function invert3(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!det) return null;
  return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, -(a * f - c * d) / det, C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
}

const BRADFORD = [0.8951, 0.2664, -0.1614, -0.7502, 1.7135, 0.0367, 0.0389, -0.0685, 1.0296];
/** The Bradford chromatic adaptation from white `src` to white `dst` (XYZ), row-major. */
export function bradford(src, dst) {
  const ms = mul3(BRADFORD, src), md = mul3(BRADFORD, dst);
  const scale = [md[0] / ms[0], 0, 0, 0, md[1] / ms[1], 0, 0, 0, md[2] / ms[2]];
  return mulM(invert3(BRADFORD), mulM(scale, BRADFORD));
}

/** RGB to D50 XYZ (row-major, columns the colorants) for primaries and a white point given as xy. */
export function rgbToXyzD50(primaries, white) {
  const [r, g, b] = primaries.map(xyToXYZ);
  const w = xyToXYZ(white);
  const m = [r[0], g[0], b[0], r[1], g[1], b[1], r[2], g[2], b[2]];
  const s = mul3(invert3(m), w);
  const rgb = [m[0] * s[0], m[1] * s[1], m[2] * s[2], m[3] * s[0], m[4] * s[1], m[5] * s[2], m[6] * s[0], m[7] * s[1], m[8] * s[2]];
  return mulM(bradford(w, D50), rgb);
}

const fixed = (v) => Math.round(v * 65536) | 0;

/**
 * The ICC bytes of a display profile (RGB matrix/TRC or Gray TRC); deterministic for the same arguments. v4.3 with
 * 'mluc' texts and 'para' curves; `legacy: true` writes v2.4 with 'desc' / 'text' tags and 'curv' curves (what older
 * readers expect, and what the tests read back). A `table` curve is always written as 'curv'.
 */
export function writeIcc({ name, copyright = 'No copyright, use freely', space = 'rgb', primaries, white = [0.3127, 0.329], trc, matrix = null, legacy = false }) {
  const tags = [];
  const mluc = (s) => {
    const str = String(s);
    const out = new Uint8Array(28 + str.length * 2);
    out.set([0x6d, 0x6c, 0x75, 0x63]);
    const dv = new DataView(out.buffer);
    dv.setUint32(8, 1);
    dv.setUint32(12, 12);
    out.set([0x65, 0x6e, 0x55, 0x53], 16); // enUS
    dv.setUint32(20, str.length * 2);
    dv.setUint32(24, 28);
    for (let i = 0; i < str.length; i++) dv.setUint16(28 + i * 2, str.charCodeAt(i));
    return out;
  };
  const xyzTag = (v) => {
    const out = new Uint8Array(20);
    out.set([0x58, 0x59, 0x5a, 0x20]);
    const dv = new DataView(out.buffer);
    v.forEach((x, i) => dv.setInt32(8 + i * 4, fixed(x)));
    return out;
  };
  const sf32 = (m) => {
    const out = new Uint8Array(44);
    out.set([0x73, 0x66, 0x33, 0x32]);
    const dv = new DataView(out.buffer);
    m.forEach((x, i) => dv.setInt32(8 + i * 4, fixed(x)));
    return out;
  };
  const desc = (str) => {
    // v2 textDescriptionType: ASCII with its terminator, then empty Unicode and ScriptCode parts
    const out = new Uint8Array(12 + str.length + 1 + 8 + 3 + 67);
    out.set([0x64, 0x65, 0x73, 0x63]);
    new DataView(out.buffer).setUint32(8, str.length + 1);
    for (let i = 0; i < str.length; i++) out[12 + i] = str.charCodeAt(i) & 0x7f;
    return out;
  };
  const textTag = (str) => {
    const out = new Uint8Array(8 + str.length + 1);
    out.set([0x74, 0x65, 0x78, 0x74]);
    for (let i = 0; i < str.length; i++) out[8 + i] = str.charCodeAt(i) & 0x7f;
    return out;
  };
  const curv = (c) => {
    const table = c.kind === 'table' ? c.t : null;
    const n = table ? table.length : 1;
    const out = new Uint8Array(12 + n * 2 + (n % 2 ? 2 : 0));
    out.set([0x63, 0x75, 0x72, 0x76]);
    const dv = new DataView(out.buffer);
    dv.setUint32(8, n);
    if (table) table.forEach((v, i) => dv.setUint16(12 + i * 2, Math.round(Math.min(1, Math.max(0, v)) * 65535)));
    else dv.setUint16(12, Math.round(c.g * 256));
    return out;
  };
  const para = (c) => {
    if (c.kind === 'table' || (legacy && c.kind === 'gamma')) return curv(c);
    if (legacy) return curv({ kind: 'table', t: Float64Array.from({ length: 1024 }, (_, i) => evalCurve(c, i / 1023)) });
    const p = c.kind === 'gamma' ? [c.g] : c.p;
    const type = c.kind === 'gamma' ? 0 : c.type;
    const out = new Uint8Array(12 + p.length * 4);
    out.set([0x70, 0x61, 0x72, 0x61]);
    const dv = new DataView(out.buffer);
    dv.setUint16(8, type);
    p.forEach((x, i) => dv.setInt32(12 + i * 4, fixed(x)));
    return out;
  };
  const whiteXYZ = xyToXYZ(white);
  tags.push(['desc', legacy ? desc(String(name)) : mluc(name)], ['cprt', legacy ? textTag(String(copyright)) : mluc(copyright)], ['wtpt', xyzTag(D50)]);
  if (space === 'rgb') {
    const m = matrix ?? rgbToXyzD50(primaries, white);
    tags.push(['chad', sf32(bradford(whiteXYZ, D50))]);
    tags.push(['rXYZ', xyzTag([m[0], m[3], m[6]])], ['gXYZ', xyzTag([m[1], m[4], m[7]])], ['bXYZ', xyzTag([m[2], m[5], m[8]])]);
    const curve = para(trc);
    tags.push(['rTRC', curve], ['gTRC', curve], ['bTRC', curve]);
  } else {
    tags.push(['kTRC', para(trc)]);
  }
  // the data, 4-byte aligned; a curve shared by three tags is written once (as Apple's and LittleCMS's profiles do)
  const tableEnd = 128 + 4 + tags.length * 12;
  let at = tableEnd;
  const placed = new Map();
  const entries = tags.map(([s, data]) => {
    if (!placed.has(data)) {
      at = (at + 3) & ~3;
      placed.set(data, at);
      at += data.length;
    }
    return { s, off: placed.get(data), len: data.length };
  });
  const size = (at + 3) & ~3;
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, size);
  dv.setUint32(8, legacy ? 0x02400000 : 0x04300000); // ICC 2.4 or 4.3
  out.set([0x6d, 0x6e, 0x74, 0x72], 12); // 'mntr'
  out.set(space === 'rgb' ? [0x52, 0x47, 0x42, 0x20] : [0x47, 0x52, 0x41, 0x59], 16);
  out.set([0x58, 0x59, 0x5a, 0x20], 20); // PCS 'XYZ '
  [2026, 1, 1, 0, 0, 0].forEach((v, i) => dv.setUint16(24 + i * 2, v)); // a fixed date: the same bytes every time
  out.set([0x61, 0x63, 0x73, 0x70], 36); // 'acsp'
  D50.forEach((v, i) => dv.setInt32(68 + i * 4, fixed(v)));
  dv.setUint32(128, entries.length);
  entries.forEach((e, i) => {
    const o = 132 + i * 12;
    for (let k = 0; k < 4; k++) out[o + k] = e.s.charCodeAt(k);
    dv.setUint32(o + 4, e.off);
    dv.setUint32(o + 8, e.len);
  });
  for (const [data, off] of placed) out.set(data, off);
  return out;
}

// ---- the generated profiles ----------------------------------------------------------------------------------------

const SRGB_TRC = { kind: 'para', type: 3, p: [2.4, 1 / 1.055, 0.055 / 1.055, 1 / 12.92, 0.04045] };
const D65 = [0.3127, 0.329];

/**
 * Pigment's built-in profiles (S6.1, "generated profiles"): the definitions their bytes are written from. The names
 * say "compatible" where the space has a trademarked name; the numbers are the published ones.
 */
export const BUILTIN_DEFS = [
  { id: 'srgb', wellKnown: 'srgb', name: 'sRGB IEC61966-2.1', space: 'rgb', primaries: [[0.64, 0.33], [0.3, 0.6], [0.15, 0.06]], white: D65, trc: SRGB_TRC },
  { id: 'display-p3', wellKnown: 'display-p3', name: 'Display P3', space: 'rgb', primaries: [[0.68, 0.32], [0.265, 0.69], [0.15, 0.06]], white: D65, trc: SRGB_TRC },
  { id: 'adobe-rgb', wellKnown: 'adobe-rgb', name: 'Adobe RGB (1998)-compatible', space: 'rgb', primaries: [[0.64, 0.33], [0.21, 0.71], [0.15, 0.06]], white: D65, trc: { kind: 'gamma', g: 563 / 256 } },
  { id: 'prophoto', wellKnown: 'prophoto', name: 'ProPhoto RGB-compatible', space: 'rgb', primaries: [[0.7347, 0.2653], [0.1596, 0.8404], [0.0366, 0.0001]], white: [0.3457, 0.3585], trc: { kind: 'gamma', g: 1.8 } },
  { id: 'gray-gamma-2.2', wellKnown: 'gray-gamma-2.2', name: 'Gray Gamma 2.2', space: 'gray', white: D65, trc: { kind: 'gamma', g: 2.2 } },
];

const builtinBytes = new Map();
/** The bytes of a built-in profile (generated once). */
export function builtinIcc(id) {
  if (!builtinBytes.has(id)) {
    const def = BUILTIN_DEFS.find((d) => d.id === id);
    builtinBytes.set(id, def ? writeIcc(def) : null);
  }
  return builtinBytes.get(id);
}

/** The model a fast path uses: { space, matrix (row-major RGB → D50 XYZ) | null, curves, lut } of parsed bytes. */
export function modelOf(parsed) {
  if (!parsed) return null;
  const m = parsed.matrix;
  return {
    space: parsed.space,
    matrix: m ? [m.r[0], m.g[0], m.b[0], m.r[1], m.g[1], m.b[1], m.r[2], m.g[2], m.b[2]] : null,
    curves: parsed.curves,
    lut: parsed.lut,
  };
}

const builtinModels = new Map();
const builtinModel = (id) => {
  if (!builtinModels.has(id)) builtinModels.set(id, modelOf(parseIcc(builtinIcc(id))));
  return builtinModels.get(id);
};

function curvesClose(a, b, tol) {
  for (let i = 0; i <= 32; i++) {
    const x = i / 32;
    if (Math.abs(evalCurve(a, x) - evalCurve(b, x)) > tol) return false;
  }
  return true;
}

/**
 * Which built-in space a parsed profile is, whoever wrote it: the colorants within 0.002 and every tone curve within
 * half an 8-bit level of the built-in's. An sRGB profile from a camera or a browser is 'srgb' whatever its bytes.
 */
export function wellKnownOf(parsed) {
  if (!parsed?.curves) return null;
  const model = modelOf(parsed);
  for (const def of BUILTIN_DEFS) {
    if (def.space !== parsed.space) continue;
    const ref = builtinModel(def.id);
    if (parsed.space === 'rgb') {
      if (!model.matrix || parsed.lut && !model.matrix) continue;
      if (model.matrix.some((v, i) => Math.abs(v - ref.matrix[i]) > 0.002)) continue;
      if (!parsed.curves.every((c) => curvesClose(c, ref.curves[0], 0.5 / 255))) continue;
      return def.wellKnown;
    }
    if (curvesClose(parsed.curves[0], ref.curves[0], 0.5 / 255)) return def.wellKnown;
  }
  return null;
}

// ---- ColorProfile records (S6.1) -------------------------------------------------------------------------------------

/**
 * The ColorProfile record of profile bytes: { id: sha-1 hex, name, bytes, colorSpace, wellKnown, source }, or null for
 * bytes that are not a profile or are of a space Pigment does not handle (XYZ, multi-channel, ...).
 */
export function profileRecord(bytes, source = 'embedded', { name: fallbackName = '' } = {}) {
  const b = bytes instanceof Uint8Array ? bytes : bytes ? new Uint8Array(bytes) : null;
  const parsed = parseIcc(b);
  if (!parsed?.space) return null;
  const size = u32(b, 0);
  const own = size === b.length ? b : b.slice(0, size);
  return {
    id: sha1Hex(own),
    name: parsed.name || fallbackName || 'Untitled profile',
    bytes: own,
    colorSpace: parsed.space,
    wellKnown: wellKnownOf(parsed),
    source,
  };
}

// ---- Lab (D50) -------------------------------------------------------------------------------------------------------

const labF = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
const labFi = (t) => (t * t * t > 216 / 24389 ? t * t * t : (116 * t - 16) / (24389 / 27));

/** D50 XYZ to CIE Lab. */
export function xyzToLab([x, y, z]) {
  const fx = labF(x / D50[0]), fy = labF(y / D50[1]), fz = labF(z / D50[2]);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}
/** CIE Lab to D50 XYZ. */
export function labToXyz([L, a, b]) {
  const fy = (L + 16) / 116;
  return [labFi(fy + a / 500) * D50[0], labFi(fy) * D50[1], labFi(fy - b / 200) * D50[2]];
}

export { D50 };
