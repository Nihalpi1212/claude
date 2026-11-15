// Font data for the HarfBuzz engine (type-engine-core, ARCHITECTURE.md "0.4 features", package 1; B.2, B.3, B.4).
//
// Faces come from three places: font files handed to addFontData (tests through __pigmentTest.addFont, later the
// type-fonts package), and the fonts installed on the system, read with window.queryLocalFonts() and FontData.blob()
// where the platform allows it (Electron grants 'local-fonts'; the browser build only when the permission is already
// granted, which tools/text.js asks for from a user gesture). Faces are loaded by family on demand: the engine's
// supports(layer) asks for a family it has no face of, and fontsChanged() redraws every text layer when the faces
// arrive (B.4). Each face is also registered as a CSS FontFace under a private name, so colour glyphs and the Canvas
// fallback draw exactly these bytes.
import { loadHarfBuzz, harfBuzz, openFace, faceCount, faceMetrics, glyphCommands, shapePiece, clearShapeCache, drawnSize } from './shaper.js';

const families = new Map(); // lower-case family -> FaceRec[]
const byPostScript = new Map(); // postScriptName -> FaceRec
let nextId = 1;
let notify = () => {};

/** The callback that tells the facade faces arrived (layout.js wires it to api.js fontsChanged). */
export function onFacesChanged(fn) {
  notify = typeof fn === 'function' ? fn : () => {};
}

const familyKey = (f) => String(f ?? '').trim().replace(/^["']|["']$/g, '').toLowerCase();

/**
 * Adds every face of a font file (a .ttc holds several). meta: { family, postScriptName, fullName, style } overrides
 * the names read from the file (FontData from queryLocalFonts carries them). Needs HarfBuzz loaded. Returns the recs.
 */
export function addFaces(bytes, meta = {}) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const out = [];
  const count = faceCount(data);
  for (let i = 0; i < count; i++) {
    const rec = openFace(data, i);
    if (!rec) break;
    // in a collection only the face the caller named takes its names; the others keep their own
    const named = count === 1 || (meta.postScriptName && meta.postScriptName === rec.names.postScriptName);
    rec.family = (named && meta.family) || rec.names.family || meta.family || 'Unknown';
    rec.postScriptName = (named && meta.postScriptName) || rec.names.postScriptName || '';
    rec.fullName = (named && meta.fullName) || rec.names.fullName || rec.family;
    if (named && typeof meta.weight === 'number') rec.weight = meta.weight;
    if (named && typeof meta.italic === 'boolean') rec.italic = meta.italic;
    rec.id = nextId++;
    rec.cssFamily = `pigment-face-${rec.id}`;
    rec.bytes = data;
    const key = familyKey(rec.family);
    const list = families.get(key) ?? [];
    // the same face added twice replaces the first
    const same = list.findIndex((r) => r.postScriptName && r.postScriptName === rec.postScriptName);
    if (same >= 0) list.splice(same, 1, rec);
    else list.push(rec);
    families.set(key, list);
    if (rec.postScriptName) byPostScript.set(rec.postScriptName, rec);
    out.push(rec);
  }
  clearShapeCache();
  return out;
}

/** Registers the faces with the page's font set (colour glyphs and fallback text are drawn with fillText). */
async function registerCss(recs) {
  if (typeof FontFace === 'undefined' || typeof document === 'undefined' || !document.fonts) return;
  await Promise.all(recs.map(async (rec) => {
    if (rec.fontFace) return;
    try {
      // the bytes of a collection hold every face: FontFace takes the first, so collections keep the Canvas name only
      if (faceCount(rec.bytes) > 1) return;
      const ff = new FontFace(rec.cssFamily, rec.bytes);
      await ff.load();
      document.fonts.add(ff);
      rec.fontFace = ff;
    } catch {
      rec.fontFace = null;
    }
  }));
  // FontFace copied the bytes; the HarfBuzz blob holds its own copy
  for (const rec of recs) rec.bytes = null;
}

/** A font file arrives (B.3 addFontData): its faces join the registry and every text layer is laid out again. */
export async function addFontData(bytes, meta = {}) {
  await loadHarfBuzz();
  const recs = addFaces(bytes, meta);
  await registerCss(recs);
  notify();
  return recs.map(describeFace);
}

const describeFace = (r) => ({ family: r.family, postScriptName: r.postScriptName, fullName: r.fullName, weight: r.weight, italic: r.italic });

/** Every loaded face: [{ family, postScriptName, fullName, weight, italic }]. */
export function loadedFaces() {
  return [...families.values()].flat().map(describeFace);
}

/** True when some face of the family is loaded. */
export const hasFamily = (family) => families.has(familyKey(family));

/** CSS font matching (weight and style) among the faces of one family. */
function pick(list, weight, italic) {
  let cands = list.filter((r) => r.italic === !!italic);
  if (!cands.length) cands = list;
  const w = Number(weight) || 400;
  // CSS Fonts 4, 5.2: 400 tries 500 first, below 400 tries lighter first, above 500 tries heavier first
  const score = (r) => {
    const d = r.weight - w;
    if (d === 0) return 0;
    if (w >= 400 && w <= 500) {
      if (d > 0 && r.weight <= 500) return d;
      return d < 0 ? 1000 - d : 2000 + d;
    }
    if (w < 400) return d < 0 ? -d : 1000 + d;
    return d > 0 ? d : 1000 - d;
  };
  return cands.slice().sort((a, b) => score(a) - score(b))[0] ?? null;
}

/**
 * The face that draws a resolved character style, or null when its family has none loaded. postScriptName wins when
 * that face is present (A). The returned rec says whether bold or italic must be synthesised (synthBold, synthItalic).
 */
export function faceFor(st) {
  if (st.postScriptName && byPostScript.has(st.postScriptName)) return byPostScript.get(st.postScriptName);
  const list = families.get(familyKey(st.fontFamily));
  if (!list?.length) return null;
  return pick(list, st.fontWeight, st.fontItalic);
}

/** Synthetic emboldening and slant when the face is lighter or more upright than the style asks for. */
export function synthesis(rec, st) {
  return { bold: !!rec && (Number(st.fontWeight) || 400) >= 600 && rec.weight < 600, italic: !!rec && !!st.fontItalic && !rec.italic };
}

// ---- installed fonts (queryLocalFonts) -------------------------------------------------------------------------------

let localIndex = null; // lower-case family -> FontData[]
let localQuery = null;
let localTried = 0;
const loadingFamilies = new Map(); // key -> promise
const absent = new Set(); // families the installed fonts do not have (asked when the list was there)

const isElectron = () => typeof window !== 'undefined' && !!window.pigment;

// Metric-compatible substitutes (fontconfig's 30-metric-aliases): when a family is not installed, Canvas text on Linux
// is drawn with its substitute, so the engine takes the same faces and lines break where the stub's would.
const METRIC_ALIASES = {
  arial: ['liberation sans', 'arimo'],
  helvetica: ['liberation sans', 'arimo'],
  'times new roman': ['liberation serif', 'tinos'],
  times: ['liberation serif', 'tinos'],
  'courier new': ['liberation mono', 'cousine'],
  courier: ['liberation mono', 'cousine'],
  calibri: ['carlito'],
  cambria: ['caladea'],
};

async function localFontIndex() {
  if (localIndex) return localIndex;
  if (typeof window === 'undefined' || typeof window.queryLocalFonts !== 'function') return null;
  if (localQuery) return localQuery;
  // without a granted permission the browser would need a user gesture: tools/text.js asks from one, after which the
  // permission reads 'granted' and the next request finds the fonts
  if (Date.now() - localTried < 2000) return null;
  localTried = Date.now();
  localQuery = (async () => {
    try {
      if (!isElectron()) {
        const st = await navigator.permissions?.query?.({ name: 'local-fonts' });
        if (st?.state !== 'granted') return null;
      }
      const list = await window.queryLocalFonts();
      const idx = new Map();
      for (const fd of list) {
        const key = familyKey(fd.family);
        if (!idx.has(key)) idx.set(key, []);
        idx.get(key).push(fd);
      }
      localIndex = idx;
      return idx;
    } catch {
      return null;
    } finally {
      localQuery = null;
    }
  })();
  return localQuery;
}

/**
 * Loads every installed face of a family in the background (no-op when loaded, loading or absent). Resolves true
 * when faces arrived; they are announced through the faces-changed callback.
 */
export function requestFamily(family) {
  const key = familyKey(family);
  if (!key || families.has(key) || absent.has(key)) return Promise.resolve(false);
  if (loadingFamilies.has(key)) return loadingFamilies.get(key);
  const p = (async () => {
    const idx = await localFontIndex();
    if (!idx) return false;
    let list = idx.get(key);
    let alias = null;
    if (!list?.length) {
      alias = (METRIC_ALIASES[key] ?? []).find((a) => idx.get(a)?.length) ?? null;
      list = alias ? idx.get(alias) : null;
    }
    if (!list?.length) {
      absent.add(key);
      return false;
    }
    if (alias && families.has(alias)) {
      // the substitute is loaded already: the family shares its faces
      families.set(key, families.get(alias));
      notify();
      return true;
    }
    await loadHarfBuzz();
    const recs = [];
    // a collection file is read once even when several of its faces are listed
    const seen = new Map();
    for (const fd of list) {
      try {
        const blob = await fd.blob();
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const sig = `${bytes.length}:${bytes[0]}:${bytes[bytes.length >> 1]}:${bytes[bytes.length - 1]}`;
        if (seen.has(sig) && faceCount(bytes) > 1) continue;
        seen.set(sig, true);
        recs.push(...addFaces(bytes, { family: fd.family, postScriptName: fd.postScriptName, fullName: fd.fullName }));
      } catch {
        // an unreadable face is skipped; the others of the family still load
      }
    }
    if (!recs.length) {
      absent.add(key);
      return false;
    }
    if (alias) families.set(key, families.get(alias) ?? recs);
    await registerCss(recs);
    notify();
    return true;
  })().catch(() => false).finally(() => loadingFamilies.delete(key));
  loadingFamilies.set(key, p);
  return p;
}

/** Forgets what the installed-font list said (the list changed, or a permission was granted). */
export function resetLocalFonts() {
  localIndex = null;
  localTried = 0;
  absent.clear();
}

// ---- the font provider (B.3 FontProvider) -------------------------------------------------------------------------

let canvasMeasure = null; // (str, style, size) -> px; set by layout.js (document.js measureContext)
let canvasMetrics = null; // style -> metrics when the family has no face (the stub's values)

/** layout.js installs Canvas measurement and the stub's metrics for faceless runs. */
export function setCanvasFallback({ measure, metrics }) {
  canvasMeasure = measure;
  canvasMetrics = metrics;
}

function toPathData(rec, runGlyphs, originX = 0, originY = 0) {
  // Pigment's PathData (document.js): subpaths of anchors with cubic handles; quadratic segments become cubics
  const subpaths = [];
  for (const g of runGlyphs) {
    const k = g.k;
    const X = (v) => originX + g.x + v * k * g.sx;
    const Y = (v) => originY + g.y - v * k;
    let sp = null;
    let px = 0, py = 0;
    for (const c of glyphCommands(rec, g.id)) {
      const v = c.values;
      if (c.type === 'M') {
        sp = { points: [{ x: X(v[0]), y: Y(v[1]) }], closed: false };
        subpaths.push(sp);
        px = v[0];
        py = v[1];
      } else if (c.type === 'L') {
        sp?.points.push({ x: X(v[0]), y: Y(v[1]) });
        px = v[0];
        py = v[1];
      } else if (c.type === 'Q' || c.type === 'C') {
        if (!sp) continue;
        const [c1x, c1y, c2x, c2y, x, y] = c.type === 'C' ? v : [px + (2 / 3) * (v[0] - px), py + (2 / 3) * (v[1] - py), v[2] + (2 / 3) * (v[0] - v[2]), v[3] + (2 / 3) * (v[1] - v[3]), v[2], v[3]];
        const prev = sp.points[sp.points.length - 1];
        prev.outX = X(c1x);
        prev.outY = Y(c1y);
        sp.points.push({ x: X(x), y: Y(y), inX: X(c2x), inY: Y(c2y) });
        px = x;
        py = y;
      } else if (c.type === 'Z' && sp) {
        // the closing segment returns to the first anchor: a duplicate last anchor at the start point is merged
        const first = sp.points[0], last = sp.points[sp.points.length - 1];
        if (sp.points.length > 1 && Math.abs(first.x - last.x) < 1e-6 && Math.abs(first.y - last.y) < 1e-6) {
          if (last.inX !== undefined) {
            first.inX = last.inX;
            first.inY = last.inY;
          }
          sp.points.pop();
        }
        sp.closed = true;
        sp = null;
      }
    }
  }
  return { subpaths: subpaths.filter((s) => s.points.length > 1) };
}

/** Shapes `text` in one style on one line (no tracking): the units of shaper.js with the face used. */
function shapeStyle(style, text) {
  return shapePiece(text, 0, text.length, style, { faceFor, measure: (s, st, size) => canvasMeasure?.(s, st, size) ?? s.length * size * 0.5 });
}

export const harfBuzzFontProvider = {
  get available() {
    return !!harfBuzz();
  },
  /** Font-wide metrics in px at the style's size (y down: positive positions are below the baseline). */
  metrics(style) {
    const rec = harfBuzz() ? faceFor(style) : null;
    if (!rec) return canvasMetrics ? canvasMetrics(style) : null;
    const m = faceMetrics(rec);
    const k = drawnSize(style) / rec.upem;
    return {
      ascent: m.ascender * k,
      descent: -m.descender * k,
      capHeight: m.capHeight * k,
      xHeight: m.xHeight * k,
      underlinePosition: -m.underlineOffset * k,
      underlineThickness: Math.max(1, m.underlineSize * k),
      strikePosition: -m.strikeOffset * k,
      strikeThickness: Math.max(1, m.strikeSize * k),
    };
  },
  hasFeature(style, tag) {
    const rec = harfBuzz() ? faceFor(style) : null;
    return !!rec && rec.features.has(tag);
  },
  /** Glyph outlines of `text` set on one line from (0, 0) on the baseline, in px (PathData); null without a face. */
  outline(style, text) {
    const rec = harfBuzz() ? faceFor(style) : null;
    if (!rec) return null;
    const piece = shapeStyle(style, String(text ?? ''));
    const k = piece.size / rec.upem, sx = (Number(style.scaleX) || 100) / 100;
    const glyphs = [];
    let pen = 0;
    for (const u of piece.units) {
      for (const g of u.glyphs) if (u.kind !== 'fallback') glyphs.push({ id: g.id, x: pen + g.x, y: g.y, k, sx });
      pen += u.advance + ((Number(style.tracking) || 0) * style.size) / 1000;
    }
    return toPathData(rec, glyphs);
  },
  /** Advance in px of each UTF-16 unit of `text` (a cluster's advance on its first unit, 0 on the others). */
  advances(style, text) {
    const s = String(text ?? '');
    const out = new Array(s.length).fill(0);
    for (const u of shapeStyle(style, s).units) out[u.index] += u.advance;
    return out;
  },
  addFontData,
};

/** The outline of one unit's glyphs (optical kerning): PathData relative to the unit's pen start, or null. */
export function unitOutline(rec, unit, sx = 1) {
  if (!rec || unit.kind === 'fallback') return null;
  const k = unit.size / rec.upem;
  return toPathData(rec, unit.glyphs.map((g) => ({ id: g.id, x: g.x, y: g.y, k, sx })));
}
