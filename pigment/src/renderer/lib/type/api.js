// Type facade (ARCHITECTURE.md "0.4 features", B). Skeleton version; owned by type-engine-core afterwards.
//
// Text layers ask this module for their layout, bounds and pixels (document.js setTextBackend): a textExtensions
// entry first (text on a path, stacked text: lib/text-path.js), then the newest registered engine whose
// supports(layer) is true. Engines get composers (line breaking within a paragraph), a breaker (line-break
// opportunities), hyphenators, kerners, list formatters and a font provider from the registries below, so later
// packages plug in without editing the engine. Every coordinate here is in the layer's base space: document
// coordinates before `layer.transform`, the same space as layer.x / y (the top-left of the box).
//
// The skeleton's engine 'canvas' is 0.3's fillText path extended to runs and paragraphs. For content with one run
// and one paragraph style (every 0.3 layer) it draws exactly what 0.3 drew: same ctx.font, positions, spacing,
// stroke and underline rectangle (the skeleton smoke spec compares it with 0.3's algorithm).
import { setTextBackend, textExtensionFor, createCanvas, measureContext, cssFont } from '../document.js';
import { parseColor, rgbaToHex } from '../../../shared/pixels/color.js';
import { runsIn, paragraphs, charStyleAt, plainText, tidyNumber } from './model.js';

// ---- registries -----------------------------------------------------------------------------------------------

const engines = []; // registration order; tried newest first
let pinned = null;
const composers = new Map();
let breaker = null;
const hyphenators = []; // { fn, languages }
const kerners = new Map();
const listFormatters = [];
let fontProvider = null;
let fontEpoch = 0;
let app = null;

export function registerEngine(engine) {
  const i = engines.findIndex((e) => e.id === engine.id);
  if (i >= 0) engines.splice(i, 1);
  engines.push(engine);
  relayoutAll();
}
/** Pins one engine for every layer (tests, the smoke spec); null = automatic. */
export function setEngine(id) {
  pinned = id ?? null;
  relayoutAll();
}
function listEngines() {
  return engines.map((e) => e.id);
}
export { listEngines as engines };
/** The engine that draws `layer` (the pinned one when set and registered). */
export function currentEngine(layer = null) {
  if (pinned) {
    const e = engines.find((x) => x.id === pinned);
    if (e) return e;
  }
  for (let i = engines.length - 1; i >= 0; i--) if (!layer || engines[i].supports(layer)) return engines[i];
  return engines[0];
}
export function registerComposer(c) {
  composers.set(c.id, c);
}
/** The composer of that id; an unknown id gets 'single'. */
export function composer(id) {
  return composers.get(id) ?? composers.get('single');
}
export function registerBreaker(fn) {
  breaker = fn;
}
export function registerHyphenator(fn, { languages = [] } = {}) {
  hyphenators.push({ fn, languages: languages.slice() });
}
/** BCP 47 tags some hyphenator covers (the Character panel's Language list). */
export function hyphenationLanguages() {
  return [...new Set(hyphenators.flatMap((h) => h.languages))];
}
export function registerFontProvider(p) {
  fontProvider = p;
  fontsChanged();
}
export function registerKerner(mode, fn) {
  kerners.set(mode, fn);
  relayoutAll();
}
/** The kerner registered for an autoKern mode ('optical'), or null (engines then kern with the font's metrics). */
export function kerner(mode) {
  return kerners.get(mode) ?? null;
}
export function registerListFormatter(fn) {
  listFormatters.push(fn);
  relayoutAll();
}
/** The registered font provider (the stub until type-engine-core lands). */
export const fonts = {
  get available() {
    return fontProvider?.available ?? false;
  },
  metrics: (style) => fontProvider.metrics(style),
  hasFeature: (style, tag) => fontProvider.hasFeature(style, tag),
  outline: (style, text) => fontProvider.outline(style, text),
  // the optional members of FontProvider stay optional here: undefined when the registered provider lacks them, so
  // `if (fonts.addFontData)` tests the provider (the stub has neither)
  get advances() {
    return fontProvider?.advances ? (style, text) => fontProvider.advances(style, text) : undefined;
  },
  get addFontData() {
    return fontProvider?.addFontData ? (bytes, info) => fontProvider.addFontData(bytes, info) : undefined;
  },
};

/** Font data arrived or went: every layout is redone (B.4). */
export function fontsChanged() {
  fontEpoch++;
  app?.emit('type:fonts-changed', { epoch: fontEpoch });
}

/** Called by app.js: a 'type:fonts-changed' redraws every text layer of every open document (no history entry). */
export function attachApp(a) {
  app = a;
  app.on('type:fonts-changed', () => relayoutAll());
}

function relayoutAll() {
  if (!app?.docs) return;
  for (const doc of app.docs.list()) {
    let any = false;
    for (const l of doc.layers()) {
      if (l.type !== 'text') continue;
      l.touch();
      any = true;
    }
    // the dirty flag is the history's business: a canvas change event does not touch it
    if (any) doc.changed('canvas');
  }
}

// ---- displayed layout (extensions first) ----------------------------------------------------------------------

const cache = new WeakMap(); // layer -> { key, layout }

function cacheKey(layer, engine, opts) {
  return [layer.version, layer.content, layer.typeOptions, layer.x, layer.y, layer.width, layer.height, engine.id, fontEpoch, opts.width, opts.height].map((v) => (typeof v === 'object' && v ? '' : String(v))).join('|');
}

function engineLayout(layer, opts = {}) {
  const engine = currentEngine(layer);
  const width = opts.width === undefined ? layer.width ?? null : opts.width;
  const height = opts.height === undefined ? layer.height ?? null : opts.height;
  const key = cacheKey(layer, engine, { width, height });
  const hit = cache.get(layer);
  // content and typeOptions are immutable objects: identity says whether they changed
  if (hit && hit.key === key && hit.content === layer.content && hit.typeOptions === layer.typeOptions && hit.engine === engine) return hit.layout;
  const layout = engine.layout(layer, envFor(layer, width, height));
  cache.set(layer, { key, content: layer.content, typeOptions: layer.typeOptions, engine, layout });
  return layout;
}

function envFor(layer, width, height) {
  return {
    composerFor: (id) => composer(id),
    breaker: (text, lang, o) => (breaker ?? stubBreaker)(text, lang, o),
    hyphenate: (from, to) => hyphenateRange(layer, from, to),
    width,
    height,
  };
}

function hyphenateRange(layer, from, to) {
  const content = layer.content;
  const word = plainText(content).slice(from, to);
  const lang = charStyleAt(content, from).language;
  // hyphenators that name the language first, then the catch-alls (no languages); newest first in each, and one that
  // answers null passes the word on (a later package's hyphenator is not shadowed by an earlier catch-all)
  const newest = hyphenators.slice().reverse();
  const order = [...newest.filter((x) => x.languages.includes(lang)), ...newest.filter((x) => !x.languages.length)];
  if (!order.length) return null;
  const para = paragraphs(content).find((p) => from >= p.from && from <= p.to);
  const hy = para?.style.hyphenation ?? {};
  // Photoshop's "Words Longer Than n letters": a word of n letters or fewer stays whole
  if (word.length <= (hy.minWord ?? 7)) return null;
  if (hy.capitalized === false && /^\p{Lu}/u.test(word)) return null;
  let raw = null;
  for (const h of order) {
    raw = h.fn(word, lang);
    if (raw != null) break;
  }
  return (raw ?? []).filter((p) => p >= (hy.after ?? 2) && word.length - p >= (hy.before ?? 2)).map((p) => from + p);
}

/** The layout the layer displays: a textExtensions entry (text on a path, stacked text), else the engine. */
export function layoutText(layer) {
  const ext = textExtensionFor(layer);
  if (ext) return ext.layout(layer, measureContext());
  return engineLayout(layer);
}

/** Base render (no transform): { canvas, x, y }. */
export function renderText(layer) {
  const ext = textExtensionFor(layer);
  if (ext) return ext.renderBase(layer);
  const engine = currentEngine(layer);
  return engine.render(layer, engineLayout(layer));
}

/** Base bounds, padded for stroke, italics and shifts. */
export function textBounds(layer) {
  const ext = textExtensionFor(layer);
  if (ext) return ext.baseBounds(layer);
  const engine = currentEngine(layer);
  const lay = engineLayout(layer);
  if (engine.bounds) return engine.bounds(layer, lay);
  return paddedBounds(layer, lay);
}

/** Straight layout by the engine alone (extensions consume it: never consults an extension). */
export function shapeText(layer, opts = {}) {
  return engineLayout(layer, opts);
}

/** The runs of shapeText(layer, opts), every line in order. */
export function glyphRuns(layer, opts = {}) {
  return shapeText(layer, opts).lines.flatMap((l) => l.runs);
}

// ---- hit testing, carets and selections ------------------------------------------------------------------------

/** { index, affinity, line, inside } of the base-space point (x, y). */
export function hitTest(layer, x, y) {
  const ext = textExtensionFor(layer);
  const lay = layoutText(layer);
  if (ext) {
    if (ext.hitTest) return ext.hitTest(layer, lay, x, y);
    return glyphHitTest(layer, lay, x, y);
  }
  const engine = currentEngine(layer);
  if (engine.hitTest) return engine.hitTest(lay, x, y);
  return clusterHitTest(layer, lay, x, y);
}

/** { x, y, height, angle, line }: (x, y) is the caret's top end; it runs `height` px rotated `angle` from straight down. */
export function caretRect(layer, index, affinity = 'leading') {
  const ext = textExtensionFor(layer);
  const lay = layoutText(layer);
  if (ext) {
    if (ext.caretRect) return ext.caretRect(layer, lay, index, affinity);
    return glyphCaret(layer, lay, index);
  }
  const engine = currentEngine(layer);
  if (engine.caretRect) return engine.caretRect(lay, index, affinity);
  return clusterCaret(lay, index, affinity);
}

/** Quads covering [from, to): one per line for straight text, one per glyph for glyph layouts. */
export function selectionRects(layer, from, to) {
  const a = Math.min(from, to), b = Math.max(from, to);
  const ext = textExtensionFor(layer);
  const lay = layoutText(layer);
  if (ext) {
    if (ext.selectionRects) return ext.selectionRects(layer, lay, a, b);
    return glyphSelection(layer, lay, a, b);
  }
  const engine = currentEngine(layer);
  if (engine.selectionRects) return engine.selectionRects(lay, a, b);
  return clusterSelection(lay, a, b);
}

const quad = (x1, y1, x2, y2) => ({ points: [[x1, y1], [x2, y1], [x2, y2], [x1, y2]] });

/** The x of content index i on a line (its cluster's leading edge; the line end past its last cluster). */
function xOnLine(line, i) {
  for (const run of line.runs) {
    if (i < run.from || i > run.to) continue;
    const cl = run.clusters;
    let best = null;
    for (const c of cl) if (c.index <= i) best = c;
    if (best && best.index === i) return best.x;
    if (i === run.to) return run.x + run.advance;
    if (best) return best.x + best.advance;
    return run.x;
  }
  if (!line.runs.length || i <= line.runs[0].from) return line.x;
  const last = line.runs[line.runs.length - 1];
  return last.x + last.advance;
}

function lineOf(lay, index) {
  const lines = lay.lines;
  for (let k = 0; k < lines.length; k++) {
    const l = lines[k];
    const next = lines[k + 1];
    if (index >= l.from && (index < l.to || (index === l.to && (!next || next.from > index)))) return l;
  }
  return lines[lines.length - 1] ?? null;
}

function clusterCaret(lay, index) {
  const line = lineOf(lay, index);
  if (!line) return { x: 0, y: 0, height: 0, angle: 0, line: 0 };
  return { x: xOnLine(line, Math.max(line.from, Math.min(index, line.to))), y: line.top, height: line.height, angle: 0, line: line.index };
}

function clusterHitTest(layer, lay, x, y) {
  const lines = lay.lines;
  if (!lines.length) return { index: 0, affinity: 'leading', line: 0, inside: false };
  let line = lines[0];
  for (const l of lines) if (y >= l.top) line = l;
  let best = line.from, bestD = Infinity, affinity = 'leading';
  const stops = [];
  for (const run of line.runs) for (const c of run.clusters) stops.push(c.index);
  stops.push(line.runs.length ? line.runs[line.runs.length - 1].to : line.from);
  for (const i of stops) {
    const d = Math.abs(xOnLine(line, i) - x);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  if (best === line.to && line.to > line.from && !line.last) affinity = 'trailing';
  const inside = y >= lines[0].top && y <= lines[lines.length - 1].top + lines[lines.length - 1].height && x >= Math.min(...lines.map((l) => l.x)) && x <= Math.max(...lines.map((l) => l.x + l.width));
  return { index: best, affinity, line: line.index, inside };
}

function clusterSelection(lay, a, b) {
  const out = [];
  for (const line of lay.lines) {
    const s = Math.max(a, line.from), e = Math.min(b, line.to);
    if (e < s || (e === s && a !== b)) continue;
    if (a === b) continue;
    const x1 = xOnLine(line, s), x2 = e >= line.to && b > line.to && !line.last ? Math.max(xOnLine(line, e), line.x + line.width) : xOnLine(line, e);
    out.push(quad(Math.min(x1, x2), line.top, Math.max(x1, x2), line.top + line.height));
  }
  return out;
}

// glyph layouts (B.5): the caret before glyph i stands at its leading edge, font.size tall, rotated by its angle
const sizeOf = (layer) => layer.font?.size ?? charStyleAt(layer.content, 0).size;

function glyphFor(lay, index) {
  const glyphs = (lay.glyphs ?? []).filter((g) => !g.hidden);
  return { exact: glyphs.find((g) => g.index === index) ?? null, before: [...glyphs].reverse().find((g) => g.index < index) ?? null };
}

function glyphCaret(layer, lay, index) {
  const size = sizeOf(layer);
  const { exact, before } = glyphFor(lay, index);
  const g = exact ?? before;
  if (!g) return { x: lay.box?.x ?? layer.x, y: lay.box?.y ?? layer.y, height: size, angle: 0, line: 0 };
  const side = exact ? -1 : 1; // leading edge of the glyph at index, else the trailing edge of the one before
  const cos = Math.cos(g.angle), sin = Math.sin(g.angle);
  const ex = g.x + (side * cos * g.width) / 2, ey = g.y + (side * sin * g.width) / 2;
  const asc = size * 0.8;
  // "up" for a glyph rotated by angle (clockwise) is (sin, -cos)
  return { x: ex + sin * asc, y: ey - cos * asc, height: size, angle: g.angle, line: 0 };
}

function glyphHitTest(layer, lay, x, y) {
  let best = null, bestD = Infinity;
  for (const g of lay.glyphs ?? []) {
    if (g.hidden) continue;
    const d = Math.hypot(g.x - x, g.y - y);
    if (d < bestD) {
      bestD = d;
      best = g;
    }
  }
  const len = plainText(layer.content).length;
  if (!best) return { index: len, affinity: 'leading', line: 0, inside: false };
  const along = (x - best.x) * Math.cos(best.angle) + (y - best.y) * Math.sin(best.angle);
  const index = Math.min(len, best.index + (along > 0 ? 1 : 0));
  return { index, affinity: along > 0 ? 'trailing' : 'leading', line: 0, inside: bestD <= sizeOf(layer) };
}

function glyphSelection(layer, lay, a, b) {
  const size = sizeOf(layer);
  const asc = size * 0.8, desc = size * 0.25;
  const out = [];
  for (const g of lay.glyphs ?? []) {
    if (g.hidden || g.index < a || g.index >= b) continue;
    const cos = Math.cos(g.angle), sin = Math.sin(g.angle), hw = g.width / 2;
    const pt = (u, v) => [g.x + u * cos - v * sin, g.y + u * sin + v * cos];
    out.push({ points: [pt(-hw, -asc), pt(hw, -asc), pt(hw, desc), pt(-hw, desc)] });
  }
  return out;
}

// ---- stub breaker, composers, list formatter, font provider (B.6) ---------------------------------------------

/** 0.3's line breaking: an opportunity after every U+0020 and nowhere else; mandatory at U+2028. */
function stubBreaker(text) {
  const out = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === ' ') out.push({ at: i + 1, kind: 'space' });
    else if (text[i] === ' ') out.push({ at: i + 1, kind: 'mandatory' });
  }
  return out;
}

/**
 * 0.3's greedy first fit over the words of a paragraph (split at U+0020): a word that does not fit starts a new
 * line, the one space at the break is consumed, double spaces stay in the line, and a line's leading empty words
 * (spaces) are dropped as 0.3 dropped them. Each line also reports textFrom / textTo, the span 0.3 drew.
 */
const greedyComposer = {
  id: 'single',
  name: 'Single-line Composer',
  compose({ from, to, text, lineWidth, measure }) {
    const lines = [];
    let lineFrom = from, textFrom = -1, textTo = -1, n = 0;
    let ws = from;
    const words = [];
    for (let i = from; i <= to; i++) {
      if (i === to || text[i] === ' ') {
        words.push([ws, i]);
        ws = i + 1;
      }
    }
    for (const [s, e] of words) {
      if (textFrom < 0) {
        // `line` is empty: the word becomes the line whatever its width (0.3: next = word)
        if (e > s) {
          textFrom = s;
          textTo = e;
        }
        continue;
      }
      if (measure(textFrom, e) <= lineWidth(n)) textTo = e;
      else {
        lines.push({ from: lineFrom, to: s, hyphen: false, textFrom, textTo });
        n++;
        lineFrom = s;
        textFrom = e > s ? s : -1;
        textTo = e > s ? e : -1;
      }
    }
    lines.push({ from: lineFrom, to, hyphen: false, textFrom: textFrom < 0 ? lineFrom : textFrom, textTo: textFrom < 0 ? lineFrom : textTo });
    return lines;
  },
};

const ROMAN = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']];
const roman = (n) => ROMAN.reduce((s, [v, r]) => {
  let out = s;
  while (n >= v) {
    out += r;
    n -= v;
  }
  return out;
}, '');
const alpha = (n) => {
  let s = '';
  for (let k = n; k > 0; k = Math.floor((k - 1) / 26)) s = String.fromCharCode(97 + ((k - 1) % 26)) + s;
  return s;
};

/** '•' for bullets, "1." style numbering per level (counted over the consecutive list paragraphs of that level). */
function stubListFormatter(paras, index) {
  const list = paras[index]?.style?.list;
  if (!list) return null;
  if (list.type === 'bullet') return list.marker && list.marker.length <= 2 ? list.marker : '•';
  let n = list.start ?? 1;
  for (let k = index - 1; k >= 0; k--) {
    const l = paras[k]?.style?.list;
    if (!l || l.type !== 'number') break;
    if ((l.level ?? 0) === (list.level ?? 0)) n++;
  }
  const m = list.marker;
  const label = m === 'lower-alpha' ? alpha(n) : m === 'upper-alpha' ? alpha(n).toUpperCase() : m === 'lower-roman' ? roman(n) : m === 'upper-roman' ? roman(n).toUpperCase() : String(n);
  return `${label}.`;
}

/** The list marker text of paragraph `index` (the newest formatter that answers, else the stub's). */
export function listMarkerText(paras, index) {
  return listMarker(paras, index);
}

function listMarker(paras, index) {
  for (let k = listFormatters.length - 1; k >= 0; k--) {
    const s = listFormatters[k](paras, index);
    if (s !== null && s !== undefined) return s;
  }
  return stubListFormatter(paras, index);
}

const stubFontProvider = {
  available: false,
  metrics(style) {
    const ctx = measureContext();
    ctx.font = runCss(style);
    const m = ctx.measureText('Hg');
    return {
      ascent: m.fontBoundingBoxAscent ?? style.size * 0.8,
      descent: m.fontBoundingBoxDescent ?? style.size * 0.2,
      capHeight: style.size * 0.7,
      xHeight: style.size * 0.5,
      underlinePosition: style.size * 0.12,
      underlineThickness: Math.max(1, style.size / 16),
      strikePosition: -style.size * 0.3,
      strikeThickness: Math.max(1, style.size / 16),
    };
  },
  hasFeature: () => false,
  outline: () => null,
};

// ---- the 'canvas' stub engine ----------------------------------------------------------------------------------

const SUPER = 0.583, SHIFT = 0.333;
/** The size a run is drawn at (super- and subscript are smaller). */
const drawnSize = (st) => (st.position === 'super' || st.position === 'sub' ? st.size * SUPER : st.size);
/** CSS font of a resolved style, through document.js cssFont exactly as 0.3 built it. */
function runCss(st, size = drawnSize(st)) {
  return cssFont({ italic: st.fontItalic, weight: st.fontWeight, size, family: st.fontFamily });
}
/** 0.3's letter spacing in px (tidied exactly as TextLayer.font reports it). */
const spacingOf = (st) => (st.tracking ? tidyNumber((st.tracking * st.size) / 1000) : 0);
/** Plain drawing: no per-character work beyond 0.3's spaced path. */
const plainStyle = (st) => st.caps === 'normal' && st.position === 'normal' && st.scaleX === 100 && st.scaleY === 100 && !st.fauxItalic && !st.fauxBold && !st.baselineShift && !st.kern && !st.strike;
const caseText = (st, s) => (st.caps === 'all' || st.caps === 'small' ? s.toUpperCase() : s);

/**
 * Pieces of [a, b): runs split at tabs. { from, to, style, tab } (a tab piece is one '\t').
 */
function piecesOf(runs, a, b) {
  const out = [];
  for (const r of runs) {
    const s = Math.max(a, r.from), e = Math.min(b, r.to);
    if (e <= s) continue;
    out.push({ from: s, to: e, style: r.style });
  }
  return out;
}

/** 0.3's widthOf over [a, b): measureText + (length − 1) × spacing, run by run (no tracking after the last unit). */
function widthOf(ctx, text, runs, a, b, tabStop = 36) {
  const pieces = piecesOf(runs, a, b);
  if (!pieces.length) return 0;
  const hasTab = text.slice(a, b).includes('\t');
  if (pieces.length === 1 && !hasTab) {
    const p = pieces[0], s = caseText(p.style, text.slice(a, b));
    ctx.font = runCss(p.style);
    return ctx.measureText(s).width + Math.max(0, s.length - 1) * spacingOf(p.style);
  }
  let w = 0;
  pieces.forEach((p, k) => {
    const last = k === pieces.length - 1;
    const sp = spacingOf(p.style);
    let segStart = p.from;
    for (let i = p.from; i <= p.to; i++) {
      if (i < p.to && text[i] !== '\t') continue;
      const s = caseText(p.style, text.slice(segStart, i));
      if (s) {
        ctx.font = runCss(p.style);
        const endOfLine = last && i === p.to;
        w += ctx.measureText(s).width + (endOfLine ? Math.max(0, s.length - 1) : s.length) * sp;
      }
      // a tab moves to the next multiple of the tab stop from where the measured range starts (the line start)
      if (i < p.to) w = (Math.floor(w / Math.max(1, tabStop)) + 1) * Math.max(1, tabStop);
      segStart = i + 1;
    }
  });
  return w;
}

/** Width of the '-' a hyphen line end draws, in the style of the character before `at`. */
function hyphenWidthAt(ctx, content, at) {
  ctx.font = runCss(charStyleAt(content, Math.max(0, at - 1)));
  return ctx.measureText('-').width;
}

function leadingOf(st, para, maxSize) {
  if (st.leading === 'auto') return maxSize * tidyNumber(para.justification.autoLeading / 100);
  return st.leading;
}

function canvasLayout(layer, env) {
  const content = layer.content;
  const text = content.text;
  const ctx = measureContext();
  const runs = runsIn(content, 0, text.length);
  const paras = paragraphs(content);
  const W = env.width;
  // break opportunities per (language, rules): the language of the paragraph's first character and the paragraph's
  // breakRules reach the registered breaker (B.3); each distinct pair is asked once, over the whole text
  const breakCache = new Map();
  const breaksFor = (lang, rules) => {
    const key = `${lang}\u0000${rules}`;
    if (!breakCache.has(key)) breakCache.set(key, env.breaker(text, lang, { rules }) ?? []);
    return breakCache.get(key);
  };
  const raw = [];
  paras.forEach((p) => {
    const ps = p.style;
    // forced line breaks (U+2028) split the paragraph into segments composed one by one
    const segs = [];
    let s = p.from;
    for (let i = p.from; i < p.to; i++) if (text[i] === ' ') {
      segs.push([s, i, i + 1]);
      s = i + 1;
    }
    segs.push([s, p.to, p.to]);
    let firstOfPara = true;
    const breaks = W === null || W === undefined || p.from === p.to ? [] : breaksFor(charStyleAt(content, p.from).language ?? 'en-US', ps.breakRules ?? 'standard');
    for (const [sf, st, next] of segs) {
      const indentFirst = firstOfPara ? ps.indentFirst : 0;
      if (W === null || W === undefined || p.from === p.to) {
        raw.push({ para: p, from: sf, to: next, textFrom: sf, textTo: st, first: firstOfPara, hyphen: false });
      } else {
        const comp = env.composerFor(ps.composer);
        const lineWidth = (n) => W - ps.indentLeft - ps.indentRight - (n === 0 ? indentFirst : 0);
        const out = comp.compose({
          from: sf,
          to: st,
          text,
          lineWidth,
          measure: (a, b) => widthOf(ctx, text, runs, a, b, ps.tabStop),
          spaceWidth: (at) => widthOf(ctx, text, runs, at, at + 1, ps.tabStop),
          hyphenWidth: (at) => {
            const stl = charStyleAt(content, Math.max(0, at - 1));
            ctx.font = runCss(stl);
            return ctx.measureText('-').width;
          },
          breaks: breaks.filter((b) => b.at > sf && b.at < st),
          hyphenate: ps.hyphenate ? (a, b) => env.hyphenate(a, b) ?? [] : null,
          style: ps,
        });
        out.forEach((l, k) => {
          const textFrom = l.textFrom ?? l.from;
          let textTo = l.textTo ?? l.to;
          if (l.textTo === undefined && k < out.length - 1 && text[textTo - 1] === ' ') textTo--;
          raw.push({ para: p, from: l.from, to: k === out.length - 1 ? next : l.to, textFrom, textTo, first: firstOfPara && k === 0, hyphen: !!l.hyphen, justify: l.justify, hang: l.hang });
        });
      }
      firstOfPara = false;
    }
  });

  // measure, then place lines vertically
  const lines = raw.map((r, index) => {
    const ps = r.para.style;
    const lineRuns = piecesOf(runs, r.textFrom, r.textTo);
    const at = charStyleAt(content, r.textFrom < text.length ? r.textFrom : Math.max(0, r.from - 1));
    const styles = lineRuns.length ? lineRuns.map((x) => x.style) : [at];
    const maxSize = Math.max(...styles.map((s) => s.size));
    const leading = Math.max(...styles.map((s) => leadingOf(s, ps, maxSize)));
    // a hyphen line ends with '-' in the style of its last character: drawn after the line and part of its width
    const hyphenW = r.hyphen ? hyphenWidthAt(ctx, content, r.textTo) : 0;
    const width = widthOf(ctx, text, runs, r.textFrom, r.textTo, ps.tabStop) + hyphenW;
    const lastOfPara = !raw[index + 1] || raw[index + 1].para !== r.para;
    return { r, ps, lineRuns, styles, maxSize, leading, width, hyphenW, lastOfPara };
  });
  const step0 = lines[0]?.leading ?? 0;
  const uniform = lines.every((l, i) => l.leading === step0 && (i === 0 || !l.r.first || (!l.ps.spaceBefore && !lines[i - 1].ps.spaceAfter)));
  let acc = 0;
  const offsets = lines.map((l, i) => {
    if (uniform) return i * step0;
    if (i > 0) {
      acc += lines[i - 1].leading;
      if (l.r.first) acc += lines[i - 1].ps.spaceAfter + l.ps.spaceBefore;
    }
    return acc;
  });
  const contentHeight = lines.length ? (uniform ? lines.length * step0 : offsets[offsets.length - 1] + lines[lines.length - 1].leading) : 0;
  const measuredWidth = W ?? Math.max(1, ...lines.map((l) => l.width));
  const lw = Math.ceil(measuredWidth);
  const ascent0 = (lines[0]?.maxSize ?? charStyleAt(content, 0).size) * 0.8;
  const H = env.height;

  const out = lines.map((l, i) => {
    const { r, ps } = l;
    const indentFirst = r.first ? ps.indentFirst : 0;
    // hanging punctuation (a composer's `hang`): the line reaches `start` px into the left margin and `end` px into the right
    const hangStart = Number(r.hang?.start) || 0, hangEnd = Number(r.hang?.end) || 0;
    const start = ps.indentLeft + indentFirst - hangStart;
    const avail = lw - ps.indentLeft - ps.indentRight - indentFirst + hangStart + hangEnd;
    const justify = ps.align.startsWith('justify') && (!l.lastOfPara || ps.align === 'justify-all') && W !== null && W !== undefined;
    const align = ps.align === 'center' ? 'center' : ps.align === 'right' ? 'right' : ps.align.startsWith('justify') && !justify ? { 'justify-center': 'center', 'justify-right': 'right' }[ps.align] ?? 'left' : 'left';
    const spaces = justify ? (text.slice(r.textFrom, r.textTo).match(/ /g) ?? []).length : 0;
    // a composer's `justify` (extra px per space and per glyph gap, glyph scale) is applied as given; without one the
    // stub spreads the extra width over the spaces (0.3 had no justification; the stub composer returns none)
    const wordSpace = r.justify ? Number(r.justify.wordSpace) || 0 : justify && spaces ? Math.max(0, avail - l.width) / spaces : 0;
    const letterSpace = r.justify ? Number(r.justify.letterSpace) || 0 : 0;
    const glyphScale = r.justify && Number(r.justify.glyphScale) > 0 ? Number(r.justify.glyphScale) : 1;
    // the expression order is 0.3's (ox + l.width − line.width for right alignment), so positions match bit for bit
    const offX = (ox) => (align === 'center' ? ox + start + (avail - l.width) / 2 : align === 'right' ? ox + start + avail - l.width : ox + start);
    const x = offX(layer.x);
    const top = layer.y + offsets[i];
    const baseline = layer.y + ascent0 + offsets[i];
    const visible = H === null || H === undefined || offsets[i] + l.leading <= H + 1e-6 || i === 0;
    const line = {
      index: i,
      para: r.para.index,
      from: r.from,
      to: r.to,
      x,
      top,
      baseline,
      width: l.width,
      height: l.leading,
      ascent: l.maxSize * 0.8,
      descent: l.maxSize * 0.2,
      visible,
      hyphen: r.hyphen,
      last: l.lastOfPara,
      text: text.slice(r.textFrom, r.textTo),
      runs: [],
      // engine internals (the render repeats 0.3's expressions from them)
      _textFrom: r.textFrom,
      _textTo: r.textTo,
      _offX: offX,
      _offY: offsets[i],
      _wordSpace: wordSpace,
      _letterSpace: letterSpace,
      _glyphScale: glyphScale,
      _hyphenWidth: l.hyphenW,
      _tabStop: ps.tabStop,
      _list: r.first && ps.list ? listMarker(content.paras, r.para.index) : null,
    };
    // runs with their x positions (clusters lazily: hit testing needs them, drawing does not)
    let cx = x;
    const pieces = piecesOf(runs, r.textFrom, r.textTo);
    pieces.forEach((p, k) => {
      const last = k === pieces.length - 1;
      const st = p.style;
      const units = letterSpace ? [...text.slice(p.from, p.to)].length - (last ? 1 : 0) : 0;
      const adv = (widthOf(ctx, text, runs, p.from, p.to, ps.tabStop) + (last ? 0 : spacingOf(st)) + (wordSpace ? (text.slice(p.from, p.to).match(/ /g) ?? []).length * wordSpace : 0) + Math.max(0, units) * letterSpace) * glyphScale;
      const shift = (st.baselineShift || 0) + (st.position === 'super' ? st.size * SHIFT : st.position === 'sub' ? -st.size * SHIFT : 0);
      const run = {
        from: p.from,
        to: p.to,
        x: cx,
        baseline: baseline - shift,
        advance: adv,
        style: st,
        css: runCss(st),
        scaleX: st.scaleX / 100,
        scaleY: st.scaleY / 100,
      };
      let clusters = null;
      Object.defineProperty(run, 'clusters', {
        enumerable: true,
        get() {
          if (!clusters) clusters = clustersOf(text, run, wordSpace, letterSpace, glyphScale);
          return clusters;
        },
      });
      line.runs.push(run);
      cx += adv;
    });
    return line;
  });
  const height = H === null || H === undefined ? Math.ceil(contentHeight) : H;
  return {
    engine: 'canvas',
    frame: { width: layer.width ?? null, height: layer.height ?? null },
    width: lw,
    height,
    contentHeight,
    overflow: H !== null && H !== undefined && contentHeight > H + 1e-6,
    ascent: ascent0,
    lineHeight: step0,
    lines: out,
  };
}

/** Grapheme cluster starts of a run with their x and advance (spacing after each, as drawSpaced places them). */
function clustersOf(text, run, wordSpace, letterSpace = 0, glyphScale = 1) {
  const ctx = measureContext();
  const st = run.style;
  ctx.font = run.css;
  const sp = spacingOf(st) + letterSpace;
  const s = text.slice(run.from, run.to);
  const seg = typeof Intl !== 'undefined' && Intl.Segmenter ? [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(s)].map((g) => [g.index, g.segment]) : [...s].reduce((acc, ch) => {
    const at = acc.length ? acc[acc.length - 1][0] + acc[acc.length - 1][1].length : 0;
    acc.push([at, ch]);
    return acc;
  }, []);
  const out = [];
  let prefix = 0;
  for (let k = 0; k < seg.length; k++) {
    const [i, g] = seg[k];
    // positions from the measured prefix (kerning between characters counts, as fillText of the whole string draws it)
    const x = run.x + ((sp ? prefix : ctx.measureText(caseText(st, s.slice(0, i))).width) + (wordSpace ? (s.slice(0, i).match(/ /g) ?? []).length * wordSpace : 0)) * glyphScale;
    const w = (ctx.measureText(caseText(st, g)).width + sp + (wordSpace && g === ' ' ? wordSpace : 0)) * glyphScale;
    out.push({ index: run.from + i, x, advance: w });
    prefix += ctx.measureText(caseText(st, g)).width + sp;
  }
  return out;
}

/** 0.3's drawSpaced: per code point when spacing is set, the stroke under each fill. */
function drawSpaced(ctx, t, x, y, spacing, stroke) {
  const paint = (s, px) => {
    if (stroke && stroke.width > 0) {
      ctx.lineWidth = stroke.width;
      ctx.strokeStyle = stroke.color ?? '#000';
      ctx.lineJoin = 'round';
      ctx.strokeText(s, px, y);
    }
    ctx.fillText(s, px, y);
  };
  if (!spacing) return paint(t, x);
  let cx = x;
  for (const ch of t) {
    paint(ch, cx);
    cx += ctx.measureText(ch).width + spacing;
  }
}

function paddedBounds(layer, lay) {
  const styles = runsIn(layer.content, 0, Infinity).map((r) => r.style);
  if (!styles.length) styles.push(charStyleAt(layer.content, 0));
  const size = Math.max(...styles.map((s) => s.size));
  const stroke = Math.max(0, ...styles.map((s) => s.stroke?.width ?? 0));
  // shifts, faux italics and scales reach beyond 0.3's padding: add them only when used (0.3 layers keep 0.3's box)
  const extra = Math.max(0, ...styles.map((s) => Math.abs(s.baselineShift || 0) + (s.position !== 'normal' ? s.size * SHIFT : 0) + (s.fauxItalic ? s.size * 0.2 : 0) + (s.scaleY > 100 ? (s.size * (s.scaleY - 100)) / 100 : 0)));
  const pad = Math.ceil(size * 0.3) + stroke + Math.ceil(extra);
  return { x: Math.floor(layer.x - pad), y: Math.floor(layer.y - pad), width: Math.ceil(lay.width + pad * 2), height: Math.ceil(lay.height + pad * 2) };
}

function canvasRender(layer, lay) {
  const content = layer.content;
  const text = content.text;
  const b = paddedBounds(layer, lay);
  const canvas = createCanvas(b.width, b.height);
  const ctx = canvas.getContext('2d');
  ctx.textBaseline = 'alphabetic';
  const ox = layer.x - b.x, oy = layer.y - b.y;
  for (const line of lay.lines) {
    if (!line.visible) continue;
    const x0 = line._offX(ox);
    const y = oy + lay.ascent + line._offY;
    if (line._list) {
      const st = charStyleAt(content, line.from);
      ctx.font = runCss(st);
      ctx.fillStyle = rgbaToHex(parseColor(st.color), true);
      ctx.fillText(line._list, x0 - ctx.measureText(line._list).width - st.size * 0.25, y);
    }
    const runs = line.runs;
    if (runs.length === 1 && plainStyle(runs[0].style) && !line.text.includes('\t') && !line._wordSpace && !line._letterSpace && line._glyphScale === 1 && !line.hyphen) {
      // one style on the line: exactly 0.3's calls
      const st = runs[0].style;
      ctx.font = runCss(st);
      ctx.fillStyle = rgbaToHex(parseColor(st.color), true);
      drawSpaced(ctx, caseText(st, line.text), x0, y, spacingOf(st), st.stroke);
      if (st.underline) ctx.fillRect(x0, y + st.size * 0.12, line.width, Math.max(1, st.size / 16));
      continue;
    }
    let cx = x0;
    runs.forEach((run) => {
      const st = run.style;
      const yy = y + (run.baseline - line.baseline); // baseline shift, super- and subscript
      ctx.save();
      ctx.font = runCss(st);
      ctx.fillStyle = rgbaToHex(parseColor(st.color), true);
      const sp = spacingOf(st) + line._letterSpace;
      // scale (with a composer's glyph scale) and faux italic about the run's start on the baseline
      const sx = run.scaleX * line._glyphScale;
      if (sx !== 1 || run.scaleY !== 1 || st.fauxItalic) {
        ctx.translate(cx, yy);
        ctx.transform(sx, 0, st.fauxItalic ? -0.2 * sx : 0, run.scaleY, 0, 0);
        ctx.translate(-cx, -yy);
      }
      let px = cx;
      const s = text.slice(run.from, run.to);
      const parts = s.split('\t');
      parts.forEach((part, pi) => {
        if (pi > 0) {
          const stop = Math.max(1, line._tabStop);
          px = x0 + (Math.floor((px - x0) / stop) + 1) * stop;
        }
        const words = line._wordSpace ? part.split(' ') : [part];
        words.forEach((wd, wi) => {
          if (wi > 0) {
            const spw = ctx.measureText(' ').width + sp + line._wordSpace;
            px += spw;
          }
          if (!wd) return;
          px = drawPiece(ctx, st, wd, px, yy, sp);
        });
      });
      // the lines reach the next run (no gap between underlined runs); the line's last run ends at its last glyph
      if (st.underline) ctx.fillRect(cx, yy + st.size * 0.12, run.advance, Math.max(1, st.size / 16));
      if (st.strike) ctx.fillRect(cx, yy - st.size * 0.3, run.advance, Math.max(1, st.size / 16));
      ctx.restore();
      cx += run.advance;
    });
    if (line.hyphen) {
      // the hyphen of a hyphenated line end, in the style of the character before it
      const st = charStyleAt(content, Math.max(0, line._textTo - 1));
      ctx.font = runCss(st);
      ctx.fillStyle = rgbaToHex(parseColor(st.color), true);
      drawPiece(ctx, st, '-', cx, y, 0);
    }
  }
  return { canvas, x: b.x, y: b.y };
}

/** Draws text of one style at (x, y); returns the x after it (per character when spaced or small caps). */
function drawPiece(ctx, st, s, x, y, sp) {
  const fauxBold = (t, px, py) => {
    if (!st.fauxBold) return;
    ctx.lineWidth = st.size / 30;
    ctx.strokeStyle = ctx.fillStyle;
    ctx.lineJoin = 'round';
    ctx.strokeText(t, px, py);
  };
  const stroke = st.stroke;
  const paint = (t, px) => {
    if (stroke && stroke.width > 0) {
      ctx.save();
      ctx.lineWidth = stroke.width;
      ctx.strokeStyle = stroke.color ?? '#000';
      ctx.lineJoin = 'round';
      ctx.strokeText(t, px, y);
      ctx.restore();
    }
    fauxBold(t, px, y);
    ctx.fillText(t, px, y);
  };
  if (!sp && st.caps !== 'small' && !st.kern) {
    const t = caseText(st, s);
    paint(t, x);
    return x + ctx.measureText(t).width;
  }
  let cx = x;
  const full = ctx.font;
  for (const ch of s) {
    let t = ch;
    if (st.caps === 'all') t = ch.toUpperCase();
    else if (st.caps === 'small' && ch !== ch.toUpperCase()) {
      // small caps: lower-case letters drawn upper-cased at 80 %
      t = ch.toUpperCase();
      ctx.font = runCss(st, drawnSize(st) * 0.8);
    }
    paint(t, cx);
    cx += ctx.measureText(t).width + sp;
    ctx.font = full;
  }
  // manual kerning after the run's last character (a run boundary is made around a kerned character)
  if (st.kern) cx += (st.kern * st.size) / 1000;
  return cx;
}

/** The 'canvas' engine: 0.3's Canvas 2D text drawing extended to runs and paragraphs (B.6). */
export const canvasEngine = {
  id: 'canvas',
  supports: () => true,
  layout: canvasLayout,
  render: canvasRender,
  bounds: paddedBounds,
};

registerComposer(greedyComposer);
registerComposer({ ...greedyComposer, id: 'every', name: 'Every-line Composer' });
fontProvider = stubFontProvider;
engines.push(canvasEngine);

// TextLayer.layout(), baseBounds() and renderBase() come here (document.js)
setTextBackend({ layout: layoutText, bounds: textBounds, render: renderText });
