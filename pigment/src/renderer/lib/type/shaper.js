// Shaping (type-engine-core, ARCHITECTURE.md "0.4 features", package 1): HarfBuzz through harfbuzzjs (MIT), vendored
// by scripts/vendor/harfbuzz.mjs into src/renderer/vendor/harfbuzz/.
//
// This module turns a piece of text in one character style into "units": HarfBuzz clusters widened to whole grapheme
// clusters, each with its advance in px and the glyphs that draw it. A unit is one of
//   'glyphs'   outline glyphs of a face (drawn as Path2D by render.js),
//   'color'    glyphs of a face that carry colour data (COLR, CBDT, sbix, SVG: drawn with fillText of the face),
//   'fallback' characters the face does not have, or a run with no face data at all: measured and drawn with Canvas
//              text in the run's CSS font, so the browser's own font fallback (emoji, other scripts) still works.
// Everything here is plain JavaScript without the DOM: Canvas measurement comes in as a callback, so Node unit tests
// shape the OFL test font with the real HarfBuzz (setHarfBuzz with the npm module).

let hb = null;
let loading = null;

/** Installs a loaded harfbuzzjs module (Node tests import it from node_modules). */
export function setHarfBuzz(mod) {
  hb = mod;
  shapeCache.clear();
}
/** The loaded harfbuzzjs module, or null while the wasm is not there. */
export const harfBuzz = () => hb;

/**
 * Loads the vendored harfbuzzjs (its module evaluates the wasm with a top-level await). Resolves to the module;
 * rejects when the files are missing (a checkout without `npm install`), in which case the stub engine keeps drawing.
 */
export function loadHarfBuzz(url = new URL('../../vendor/harfbuzz/index.mjs', import.meta.url).href) {
  if (hb) return Promise.resolve(hb);
  if (!loading) {
    loading = import(url).then((m) => {
      setHarfBuzz(m);
      return m;
    }).catch((err) => {
      loading = null;
      throw err;
    });
  }
  return loading;
}

// ---- faces ---------------------------------------------------------------------------------------------------------

const u16 = (b, o) => (b[o] << 8) | b[o + 1];

/**
 * Opens face `index` of a font file. Returns { face, font, upem, names, weight, italic, features, color } or null when
 * the index holds no face (the end of a collection). Positions of the font are in font units (scale = upem).
 */
export function openFace(bytes, index = 0) {
  if (!hb) throw new Error('HarfBuzz is not loaded');
  const blob = new hb.Blob(bytes);
  const face = new hb.Face(blob, index);
  const name = (id) => {
    try {
      return face.getName(id, 'en') || '';
    } catch {
      return '';
    }
  };
  const names = { family: name(16) || name(1), subfamily: name(17) || name(2), fullName: name(4), postScriptName: name(6) };
  if (!names.family && !names.postScriptName && index > 0) return null;
  const os2 = face.referenceTable('OS/2');
  const fsSelection = os2 && os2.length > 63 ? u16(os2, 62) : 0;
  const weight = os2 && os2.length > 5 ? u16(os2, 4) || 400 : /bold/i.test(names.subfamily) ? 700 : 400;
  const italic = !!(fsSelection & 0x201) || /italic|oblique/i.test(names.subfamily);
  const tags = (table) => {
    try {
      return face.getTableFeatureTags(table);
    } catch {
      return [];
    }
  };
  const features = new Set([...tags('GSUB'), ...tags('GPOS')]);
  // a kern table without GPOS kerning still kerns: HarfBuzz applies it under the 'kern' feature
  if (face.referenceTable('kern')) features.add('kern');
  const color = { layers: face.hasColorLayers(), paint: face.hasColorPaint(), png: face.hasColorPng(), svg: !!face.referenceTable('SVG ') };
  const font = new hb.Font(face);
  return { face, font, upem: face.upem || 1000, names, weight, italic, features, color };
}

/** Number of faces in a font file (a .ttc collection has several), probing indices until one is empty. */
export function faceCount(bytes) {
  const tag = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  if (tag !== 'ttcf' || bytes.length < 12) return 1;
  return Math.max(1, (bytes[8] << 24 >>> 0) + (bytes[9] << 16) + (bytes[10] << 8) + bytes[11]);
}

/** Font-wide metrics of a face rec in font units (y up): { ascender, descender, underline, strike, capHeight, xHeight }. */
export function faceMetrics(rec) {
  if (rec._metrics) return rec._metrics;
  const T = hb.MetricsTag;
  const get = (tag, fallback) => {
    try {
      const v = rec.font.getMetricPositionWithFallback(T[tag]);
      return Number.isFinite(v) ? v : fallback;
    } catch {
      return fallback;
    }
  };
  const ext = rec.font.hExtents();
  const upem = rec.upem;
  rec._metrics = {
    ascender: ext.ascender || upem * 0.8,
    descender: ext.descender || -upem * 0.2,
    underlineOffset: get('UNDERLINE_OFFSET', -upem * 0.12),
    underlineSize: get('UNDERLINE_SIZE', upem / 16),
    strikeOffset: get('STRIKEOUT_OFFSET', upem * 0.3),
    strikeSize: get('STRIKEOUT_SIZE', upem / 16),
    capHeight: get('CAP_HEIGHT', upem * 0.7),
    xHeight: get('X_HEIGHT', upem * 0.5),
  };
  return rec._metrics;
}

/** True when the glyph draws in colour (COLRv0 layers, a COLRv1 paint graph, or a bitmap/SVG font). */
export function isColorGlyph(rec, gid) {
  const c = rec.color;
  if (!c.layers && !c.paint && !c.png && !c.svg) return false;
  rec._colorGlyphs ??= new Map();
  let v = rec._colorGlyphs.get(gid);
  if (v === undefined) {
    v = false;
    try {
      if (c.png || c.svg) v = true;
      else if (c.paint && rec.face.glyphHasColorPaint(gid)) v = true;
      else if (c.layers && rec.face.getGlyphColorLayers(gid).length > 0) v = true;
    } catch {
      v = false;
    }
    rec._colorGlyphs.set(gid, v);
  }
  return v;
}

/** The outline of a glyph as SVG path data in font units (y up), cached per face. */
export function glyphPathData(rec, gid) {
  rec._paths ??= new Map();
  let d = rec._paths.get(gid);
  if (d === undefined) {
    try {
      d = rec.font.glyphToPath(gid);
    } catch {
      d = '';
    }
    rec._paths.set(gid, d);
  }
  return d;
}

/** Drawing commands of a glyph in font units (y up): [{ type: 'M'|'L'|'Q'|'C'|'Z', values }]. */
export function glyphCommands(rec, gid) {
  try {
    return rec.font.glyphToJson(gid);
  } catch {
    return [];
  }
}

/** Ink extents of a glyph in font units: { xBearing, yBearing, width, height } (height negative: y up). */
export function glyphExtents(rec, gid) {
  rec._extents ??= new Map();
  let e = rec._extents.get(gid);
  if (e === undefined) {
    try {
      e = rec.font.glyphExtents(gid) ?? null;
    } catch {
      e = null;
    }
    rec._extents.set(gid, e);
  }
  return e;
}

// ---- style helpers shared with layout.js -----------------------------------------------------------------------------

export const SUPER_SIZE = 0.583;
export const SUPER_SHIFT = 0.333;
/** The size a run is drawn at (super- and subscript are smaller; Photoshop's 58.3 %). */
export const drawnSize = (st) => (st.position === 'super' || st.position === 'sub' ? st.size * SUPER_SIZE : st.size);
/** The baseline offset of a run in px, positive up: baseline shift plus the super/subscript shift. */
export const baselineOffset = (st) => (Number(st.baselineShift) || 0) + (st.position === 'super' ? st.size * SUPER_SHIFT : st.position === 'sub' ? -st.size * SUPER_SHIFT : 0);

// right-to-left scripts: a piece whose first strong character belongs to one of them is shaped right to left
const RTL = /[\p{Script=Hebrew}\p{Script=Arabic}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}\p{Script=Samaritan}\p{Script=Mandaic}\p{Script=Adlam}\p{Script=Hanifi_Rohingya}\p{Script=Yezidi}]/u;
const STRONG = /[\p{L}]/u;

/** 'rtl' when the first strong character of `s` is right-to-left, 'ltr' when it is another letter, null without one. */
export function directionOf(s) {
  for (const ch of s) {
    if (RTL.test(ch)) return 'rtl';
    if (STRONG.test(ch)) return 'ltr';
  }
  return null;
}

/**
 * Splits [from, to) into direction runs: a change between right-to-left and left-to-right letters starts a new one;
 * neutral characters (spaces, digits, punctuation) stay with the run before them. [{ from, to, rtl }].
 */
export function directionRuns(text, from, to) {
  const out = [];
  let cur = null;
  for (let i = from; i < to;) {
    const cp = text.codePointAt(i);
    const n = cp > 0xffff ? 2 : 1;
    const ch = text.slice(i, i + n);
    const d = RTL.test(ch) ? 'rtl' : STRONG.test(ch) ? 'ltr' : null;
    if (!cur) cur = { from: i, to: i + n, rtl: d === 'rtl' };
    else if (d && (d === 'rtl') !== cur.rtl && cur.to > cur.from) {
      // a run that has seen no strong letter yet takes the direction of the first one
      if (cur.strong) {
        out.push(cur);
        cur = { from: i, to: i + n, rtl: d === 'rtl' };
      } else {
        cur.rtl = d === 'rtl';
        cur.to = i + n;
      }
    } else cur.to = i + n;
    if (d) cur.strong = true;
    i += n;
  }
  if (cur) out.push(cur);
  return out.map(({ from: f, to: t, rtl }) => ({ from: f, to: t, rtl }));
}

let segmenter = null;
/** Grapheme cluster starts inside [from, to) of text (Intl.Segmenter, else code points). */
export function graphemeStarts(text, from, to) {
  const s = text.slice(from, to);
  const out = [];
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    segmenter ??= new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    for (const g of segmenter.segment(s)) out.push(from + g.index);
  } else {
    for (let i = 0; i < s.length;) {
      out.push(from + i);
      i += s.codePointAt(i) > 0xffff ? 2 : 1;
    }
  }
  return out;
}

// ---- case transforms (caps) -----------------------------------------------------------------------------------------

/**
 * The text a piece is shaped with and where each of its UTF-16 units came from: caps 'all' upper-cases every
 * character, caps 'small' upper-cases lower-case letters (drawn at 80 % unless the face has real small capitals).
 * Returns segments [{ str, map: number[] (original index per unit), small: boolean }].
 */
export function caseSegments(text, from, to, caps, realSmallCaps) {
  if (caps !== 'all' && caps !== 'small') return [{ str: text.slice(from, to), map: null, small: false, from, to }];
  if (caps === 'small' && realSmallCaps) return [{ str: text.slice(from, to), map: null, small: false, from, to }];
  const segs = [];
  let cur = null;
  for (let i = from; i < to;) {
    const cp = text.codePointAt(i);
    const n = cp > 0xffff ? 2 : 1;
    const ch = text.slice(i, i + n);
    const up = ch.toUpperCase();
    const small = caps === 'small' && up !== ch && ch === ch.toLowerCase();
    if (!cur || cur.small !== small) {
      cur = { str: '', map: [], small, from: i, to: i };
      segs.push(cur);
    }
    for (let k = 0; k < up.length; k++) cur.map.push(i);
    cur.str += up;
    cur.to = i + n;
    i += n;
  }
  return segs.length ? segs : [{ str: '', map: [], small: false, from, to }];
}

// ---- shaping --------------------------------------------------------------------------------------------------------

const shapeCache = new Map(); // key -> raw result; insertion order is the LRU order
const SHAPE_CACHE_MAX = 4000;
let buffer = null;

/** OpenType features of a style: the model's `features` overrides and kerning off for autoKern 'none' / optical. */
export function featureList(st, { kern = true } = {}) {
  const out = [];
  const f = st.features && typeof st.features === 'object' ? st.features : {};
  for (const [tag, v] of Object.entries(f)) if (/^[\x20-\x7e]{4}$/.test(tag)) out.push([tag, Number(v) || 0]);
  if (!kern || st.autoKern === 'none') {
    if (!out.some(([t]) => t === 'kern')) out.push(['kern', 0]);
  }
  return out;
}

/**
 * Shapes str[at, at + len) with `rec`, `context` characters on each side ([cFrom, cTo) of str) informing joining and
 * contextual forms. Returns { gid, cluster, ax, dx, dy } typed arrays in font units, clusters relative to str, in
 * visual order.
 */
export function shapeRaw(rec, str, at, len, { cFrom = at, cTo = at + len, features = [], language = null, rtl = false } = {}) {
  const ctx = str.slice(cFrom, cTo);
  const key = `${rec.id}\u0001${language ?? ''}\u0001${rtl ? 1 : 0}\u0001${features.map((f) => f.join('=')).join(',')}\u0001${at - cFrom}\u0001${len}\u0001${ctx}`;
  const hit = shapeCache.get(key);
  if (hit) {
    shapeCache.delete(key);
    shapeCache.set(key, hit);
    return hit;
  }
  buffer ??= new hb.Buffer();
  buffer.clearContents();
  buffer.addText(ctx, at - cFrom, len);
  buffer.guessSegmentProperties();
  buffer.setDirection(rtl ? hb.Direction.RTL : hb.Direction.LTR);
  if (language) {
    try {
      buffer.setLanguage(language);
    } catch {
      // a tag HarfBuzz cannot read: the guessed language stays
    }
  }
  hb.shape(rec.font, buffer, features.map(([t, v]) => new hb.Feature(t, v)));
  const gl = buffer.getGlyphInfosAndPositions();
  const n = gl.length;
  const out = { gid: new Uint32Array(n), cluster: new Int32Array(n), ax: new Float64Array(n), dx: new Float64Array(n), dy: new Float64Array(n) };
  for (let i = 0; i < n; i++) {
    const g = gl[i];
    out.gid[i] = g.codepoint;
    out.cluster[i] = g.cluster + cFrom;
    out.ax[i] = g.xAdvance;
    out.dx[i] = g.xOffset;
    out.dy[i] = g.yOffset;
  }
  shapeCache.set(key, out);
  if (shapeCache.size > SHAPE_CACHE_MAX) shapeCache.delete(shapeCache.keys().next().value);
  return out;
}

/**
 * Shapes text[from, to) in one resolved character style.
 *
 * env: { faceFor(style) -> rec | null, measure(str, style, size) -> px (Canvas text measurement in the run's CSS font),
 *        ctxFrom, ctxTo (the characters around the piece that inform shaping, default the piece) }
 * Returns a Piece: { from, to, size, face, rtl, units: [{ index, end, advance (px, horizontal scale and fractional
 * widths applied, no tracking), kind, glyphs: [{ id, x, y }] (px relative to the unit's pen start, y down), str }] }
 * Units are in logical order and cover [from, to) exactly; each starts at a grapheme boundary.
 */
export function shapePiece(text, from, to, st, env) {
  const size = drawnSize(st);
  const sx = (Number(st.scaleX) || 100) / 100;
  const rec = hb ? env.faceFor(st) : null;
  const units = [];
  const realSmall = st.caps === 'small' && !!rec?.features.has('smcp');
  const features = featureList(st, { kern: st.autoKern !== 'optical' || env.opticalFallback === true });
  if (realSmall) features.push(['smcp', 1]);
  const dirRuns = rec ? directionRuns(text, from, to) : [{ from, to, rtl: false }];
  let rtlAny = false;
  for (const dr of dirRuns) {
    if (dr.rtl) rtlAny = true;
    for (const seg of caseSegments(text, dr.from, dr.to, st.caps, realSmall)) {
      const segSize = seg.small ? size * 0.8 : size;
      shapeSegment(text, seg, dr, st, env, rec, segSize, sx, features, units);
    }
  }
  if (st.fractionalWidths === false) for (const u of units) u.advance = Math.round(u.advance);
  return { from, to, size, face: rec, rtl: rtlAny, units };
}

function shapeSegment(text, seg, dr, st, env, rec, size, sx, features, units) {
  const { from, to } = seg;
  if (to <= from) return;
  const starts = graphemeStarts(text, from, to);
  const isStart = new Set(starts);
  const fallbackUnit = (a, b) => {
    const s = seg.map ? seg.str.slice(seg.map.indexOf(a), lastIndexOf(seg.map, b - 1) + 1) : text.slice(a, b);
    units.push({ index: a, end: b, advance: env.measure(s, st, size) * sx, kind: 'fallback', glyphs: [], str: s, size, rtl: dr.rtl });
  };
  if (!rec) {
    for (let k = 0; k < starts.length; k++) fallbackUnit(starts[k], starts[k + 1] ?? to);
    return;
  }
  const k = size / rec.upem;
  // the shaping context: the piece's surroundings in the original text (not for case-mapped text, whose units differ)
  let raw;
  if (seg.map) raw = shapeRaw(rec, seg.str, 0, seg.str.length, { features, language: st.language, rtl: dr.rtl });
  else raw = shapeRaw(rec, text, from, to - from, { cFrom: Math.max(env.ctxFrom ?? from, 0), cTo: Math.min(env.ctxTo ?? to, text.length), features, language: st.language, rtl: dr.rtl });
  const origin = (c) => (seg.map ? seg.map[Math.min(seg.map.length - 1, Math.max(0, c))] : c);
  // group glyphs by cluster (in logical order), widened to grapheme boundaries
  const groups = new Map(); // unit start -> glyph indices
  const n = raw.gid.length;
  for (let i = 0; i < n; i++) {
    let c = origin(raw.cluster[i]);
    if (c < from || c >= to) continue;
    while (c > from && !isStart.has(c)) c--;
    if (!groups.has(c)) groups.set(c, []);
    groups.get(c).push(i);
  }
  const keys = [...groups.keys()].sort((a, b) => a - b);
  for (let q = 0; q < keys.length; q++) {
    const a = keys[q];
    const b = keys[q + 1] ?? to;
    const idx = groups.get(a);
    // a cluster with a missing glyph (.notdef) is drawn by Canvas, so the browser's font fallback can find it
    if (idx.some((i) => raw.gid[i] === 0)) {
      fallbackUnit(a, b);
      continue;
    }
    // HarfBuzz returns glyphs in visual order (a right-to-left buffer comes reversed): raw indices run left to right
    const vis = idx.slice().sort((p, r) => p - r);
    let pen = 0;
    const glyphs = [];
    let color = false;
    for (const i of vis) {
      glyphs.push({ id: raw.gid[i], x: (pen + raw.dx[i]) * k * sx, y: -raw.dy[i] * k });
      pen += raw.ax[i];
      if (isColorGlyph(rec, raw.gid[i])) color = true;
    }
    const s = seg.map ? seg.str.slice(seg.map.indexOf(a), lastIndexOf(seg.map, b - 1) + 1) : text.slice(a, b);
    units.push({ index: a, end: b, advance: pen * k * sx, kind: color ? 'color' : 'glyphs', glyphs, str: s, size, rtl: dr.rtl });
  }
  // characters HarfBuzz gave no glyph to (default ignorables removed): zero-width units keep the cover complete
  for (const s0 of starts) if (!units.some((u) => u.index <= s0 && s0 < u.end)) units.push({ index: s0, end: nextStart(starts, s0, to), advance: 0, kind: 'glyphs', glyphs: [], str: '', size, rtl: dr.rtl });
  units.sort((p, r) => p.index - r.index);
}

const nextStart = (starts, s, to) => starts.find((x) => x > s) ?? to;
function lastIndexOf(arr, v) {
  for (let i = arr.length - 1; i >= 0; i--) if (arr[i] <= v) return i;
  return arr.length - 1;
}

/** Drops every cached shaping result (fonts arrived or went). */
export function clearShapeCache() {
  shapeCache.clear();
}
