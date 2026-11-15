// Rich-text model of Pigment 0.4 (ARCHITECTURE.md "0.4 features", A). Pure JavaScript, no DOM:
// Node unit tests import it. Skeleton version; owned by type-engine-core afterwards.
//
// TextContent = { v: 1, text, runs: [{ len, style }], paras: [{ style }] }. Paragraphs are separated
// by '\n' (U+2028 is a forced line break inside a paragraph). Runs cover the text in order, with no
// zero-length run except the single one of an empty text (it holds the insertion style). Styles
// are sparse: only attributes that differ from CHAR_DEFAULTS / PARA_DEFAULTS are stored, and a key
// set to undefined in a patch resets it. Content is immutable: every operation returns a new
// object (callers keep the old one for undo; history entries share them).
//
// Indices are UTF-16 code units; an index that falls inside a surrogate pair snaps to the pair's
// start. A range touches the paragraphs of its characters, a caret the paragraph it is in (the
// '\n' that ends a paragraph belongs to it).
//
// Nested values (features, stroke, hyphenation, justification, list) are values: a patch replaces
// one whole, equality is deep, and normalize() drops one only when it deep-equals the default.

const freezeDeep = (o) => {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) freezeDeep(v);
  }
  return o;
};

export const CHAR_DEFAULTS = freezeDeep({
  fontFamily: 'Arial',
  fontWeight: 400,
  fontItalic: false,
  postScriptName: null,
  size: 48,
  leading: 'auto',
  tracking: 0,
  autoKern: 'metrics',
  kern: 0,
  scaleX: 100,
  scaleY: 100,
  baselineShift: 0,
  color: '#000000',
  fauxBold: false,
  fauxItalic: false,
  caps: 'normal',
  position: 'normal',
  underline: false,
  strike: false,
  language: 'en-US',
  features: {},
  fractionalWidths: true,
  noBreak: false,
  stroke: null,
});

const HYPHENATION_DEFAULTS = { minWord: 7, after: 2, before: 2, limit: 2, zone: 36, capitalized: true, lastWord: true, acrossColumn: true };
const JUSTIFICATION_DEFAULTS = { word: [80, 100, 133], letter: [0, 0, 0], glyph: [100, 100, 100], autoLeading: 120, singleWord: 'justify-all' };

export const PARA_DEFAULTS = freezeDeep({
  align: 'left',
  indentLeft: 0,
  indentRight: 0,
  indentFirst: 0,
  spaceBefore: 0,
  spaceAfter: 0,
  hyphenate: false,
  hyphenation: HYPHENATION_DEFAULTS,
  justification: JUSTIFICATION_DEFAULTS,
  composer: 'every',
  breakRules: 'standard',
  hangingPunctuation: false,
  list: null,
  tabStop: 36,
});

export const TYPE_OPTION_DEFAULTS = freezeDeep({ orientation: 'horizontal', antiAlias: 'smooth', systemLayout: false });

export const CHAR_KEYS = freezeDeep(Object.keys(CHAR_DEFAULTS));
export const PARA_KEYS = freezeDeep(Object.keys(PARA_DEFAULTS));

/** Clamping ranges of normalize() ([min, max]; values are clamped, never rounded). */
export const RANGES = freezeDeep({
  size: [0.1, 10000],
  leading: [0.1, 20000],
  tracking: [-1000, 10000],
  kern: [-1000, 10000],
  scaleX: [1, 1000],
  scaleY: [1, 1000],
  baselineShift: [-10000, 10000],
  fontWeight: [100, 900],
  'stroke.width': [0, 1000],
  indentLeft: [-10000, 10000],
  indentRight: [-10000, 10000],
  indentFirst: [-10000, 10000],
  spaceBefore: [-10000, 10000],
  spaceAfter: [-10000, 10000],
  tabStop: [1, 10000],
  'justification.word': [0, 1000],
  'justification.letter': [-100, 500],
  'justification.glyph': [50, 200],
  'justification.autoLeading': [0, 500],
  'hyphenation.minWord': [2, 25],
  'hyphenation.after': [1, 15],
  'hyphenation.before': [1, 15],
  'hyphenation.limit': [0, 25],
  'hyphenation.zone': [0, 10000],
  'list.start': [0, 9999],
  'list.level': [0, 8],
});

/** "Several values" in charAttrs() / paraAttrs() results. */
export const MIXED = Symbol('mixed');

const ENUMS = {
  autoKern: ['metrics', 'optical', 'none'],
  caps: ['normal', 'all', 'small'],
  position: ['normal', 'super', 'sub'],
  align: ['left', 'center', 'right', 'justify-left', 'justify-center', 'justify-right', 'justify-all'],
  breakRules: ['standard', 'legacy'],
  orientation: ['horizontal', 'vertical', 'vertical-stacked'],
  singleWord: ['justify-all', 'left', 'center', 'right'],
  listType: ['bullet', 'number'],
};
const BOOL_CHAR = ['fontItalic', 'fauxBold', 'fauxItalic', 'underline', 'strike', 'fractionalWidths', 'noBreak'];
const NUM_CHAR = ['size', 'tracking', 'kern', 'scaleX', 'scaleY', 'baselineShift', 'fontWeight'];
const NUM_PARA = ['indentLeft', 'indentRight', 'indentFirst', 'spaceBefore', 'spaceAfter', 'tabStop'];

// ---------------------------------------------------------------------------------------------
// Values

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const clampTo = (v, [lo, hi]) => (v < lo ? lo : v > hi ? hi : v);

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || !a || !b || typeof a !== 'object') return Number.isNaN(a) && Number.isNaN(b);
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  const ka = Object.keys(a).filter((k) => a[k] !== undefined), kb = Object.keys(b).filter((k) => b[k] !== undefined);
  return ka.length === kb.length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
}

function cloneValue(v) {
  if (Array.isArray(v)) return v.map(cloneValue);
  if (isObj(v)) {
    const o = {};
    for (const k of Object.keys(v)) if (v[k] !== undefined) o[k] = cloneValue(v[k]);
    return o;
  }
  return v;
}

/** Stable string of a value (sorted keys): the identity used to merge equal runs. */
function stableKey(v) {
  if (Array.isArray(v)) return `[${v.map(stableKey).join(',')}]`;
  if (isObj(v)) return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stableKey(v[k])}`).join(',')}}`;
  return v === undefined ? 'u' : JSON.stringify(v);
}

const ordered3 = (arr, def, range) => {
  if (!Array.isArray(arr)) return [...def];
  const out = [0, 1, 2].map((i) => (finite(arr[i]) ? clampTo(arr[i], range) : def[i]));
  return out.sort((a, b) => a - b);
};

/** A char attribute value cleaned to its type and range; undefined = invalid (dropped). */
function cleanCharValue(key, v) {
  if (v === undefined) return undefined;
  if (NUM_CHAR.includes(key)) return finite(v) ? clampTo(v, RANGES[key]) : undefined;
  if (BOOL_CHAR.includes(key)) return typeof v === 'boolean' ? v : undefined;
  switch (key) {
    case 'fontFamily':
    case 'language':
    case 'color':
      return typeof v === 'string' && v ? v : undefined;
    case 'postScriptName':
      return v === null || (typeof v === 'string' && v) ? v : undefined;
    case 'leading':
      return v === 'auto' ? v : finite(v) ? clampTo(v, RANGES.leading) : undefined;
    case 'autoKern':
    case 'caps':
    case 'position':
      return ENUMS[key].includes(v) ? v : undefined;
    case 'features': {
      if (!isObj(v)) return undefined;
      const out = {};
      for (const k of Object.keys(v)) if (finite(v[k])) out[k] = v[k];
      return out;
    }
    case 'stroke': {
      if (v === null) return null;
      if (!isObj(v)) return undefined;
      return { color: typeof v.color === 'string' && v.color ? v.color : '#000000', width: finite(v.width) ? clampTo(v.width, RANGES['stroke.width']) : 0 };
    }
    default:
      return v;
  }
}

function cleanParaValue(key, v) {
  if (v === undefined) return undefined;
  if (NUM_PARA.includes(key)) return finite(v) ? clampTo(v, RANGES[key]) : undefined;
  switch (key) {
    case 'align':
    case 'breakRules':
      return ENUMS[key].includes(v) ? v : undefined;
    case 'hyphenate':
    case 'hangingPunctuation':
      return typeof v === 'boolean' ? v : undefined;
    case 'composer':
      return typeof v === 'string' && v ? v : undefined;
    case 'hyphenation': {
      if (!isObj(v)) return undefined;
      const d = HYPHENATION_DEFAULTS, out = {};
      for (const k of ['minWord', 'after', 'before', 'limit', 'zone']) out[k] = finite(v[k]) ? clampTo(v[k], RANGES[`hyphenation.${k}`]) : d[k];
      for (const k of ['capitalized', 'lastWord', 'acrossColumn']) out[k] = typeof v[k] === 'boolean' ? v[k] : d[k];
      return out;
    }
    case 'justification': {
      if (!isObj(v)) return undefined;
      const d = JUSTIFICATION_DEFAULTS;
      return {
        word: ordered3(v.word, d.word, RANGES['justification.word']),
        letter: ordered3(v.letter, d.letter, RANGES['justification.letter']),
        glyph: ordered3(v.glyph, d.glyph, RANGES['justification.glyph']),
        autoLeading: finite(v.autoLeading) ? clampTo(v.autoLeading, RANGES['justification.autoLeading']) : d.autoLeading,
        singleWord: ENUMS.singleWord.includes(v.singleWord) ? v.singleWord : d.singleWord,
      };
    }
    case 'list': {
      if (v === null) return null;
      if (!isObj(v)) return undefined;
      const type = ENUMS.listType.includes(v.type) ? v.type : 'bullet';
      return {
        type,
        marker: typeof v.marker === 'string' && v.marker ? v.marker : type === 'number' ? 'decimal' : '•',
        start: finite(v.start) ? clampTo(v.start, RANGES['list.start']) : 1,
        level: finite(v.level) ? clampTo(v.level, RANGES['list.level']) : 0,
      };
    }
    default:
      return v;
  }
}

/** Sparse, clamped style: invalid values dropped, values equal to the default stripped. */
function cleanStyle(style, defaults, cleanValue) {
  const out = {};
  if (!isObj(style)) return out;
  for (const k of Object.keys(style)) {
    const raw = style[k];
    if (raw === undefined) continue;
    if (!Object.prototype.hasOwnProperty.call(defaults, k)) {
      out[k] = cloneValue(raw); // unknown key (a newer release): kept as it is
      continue;
    }
    const v = cleanValue(k, raw);
    if (v === undefined || deepEqual(v, defaults[k])) continue;
    out[k] = v;
  }
  return out;
}
const cleanChar = (s) => cleanStyle(s, CHAR_DEFAULTS, cleanCharValue);
const cleanPara = (s) => cleanStyle(s, PARA_DEFAULTS, cleanParaValue);

function patchStyle(style, patch) {
  const out = { ...style };
  if (isObj(patch)) {
    for (const k of Object.keys(patch)) {
      if (patch[k] === undefined) delete out[k];
      else out[k] = cloneValue(patch[k]);
    }
  }
  return out;
}

/** Character style with the defaults filled in. */
export function resolveChar(style) {
  return { ...cloneValue(CHAR_DEFAULTS), ...cloneValue(isObj(style) ? style : {}) };
}

/** Paragraph style with the defaults filled in. */
export function resolvePara(style) {
  return { ...cloneValue(PARA_DEFAULTS), ...cloneValue(isObj(style) ? style : {}) };
}

/** True when two sparse styles (character or paragraph) mean the same thing. */
export function equalStyle(a, b) {
  const strip = (s) => {
    const out = {};
    if (!isObj(s)) return out;
    for (const k of Object.keys(s)) {
      if (s[k] === undefined) continue;
      const def = k in CHAR_DEFAULTS ? CHAR_DEFAULTS[k] : k in PARA_DEFAULTS ? PARA_DEFAULTS[k] : undefined;
      if (def !== undefined && deepEqual(s[k], def)) continue;
      out[k] = s[k];
    }
    return out;
  };
  return deepEqual(strip(a), strip(b));
}

// ---------------------------------------------------------------------------------------------
// Exploded form: one style per UTF-16 unit, one per paragraph. Pigment's texts are short, so
// every operation works on it and rebuilds the runs.

function countNewlines(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
  return n;
}

const isHigh = (c) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c) => c >= 0xdc00 && c <= 0xdfff;

/** index clamped to [0, text.length] and moved off the middle of a surrogate pair. */
function snap(text, index) {
  // Infinity is "the end" (runsIn's default `to`), anything else that is not a number the start
  let i = Number.isFinite(index) ? Math.trunc(index) : index === Infinity ? text.length : 0;
  if (i < 0) i = 0;
  if (i > text.length) i = text.length;
  if (i > 0 && i < text.length && isHigh(text.charCodeAt(i - 1)) && isLow(text.charCodeAt(i))) i--;
  return i;
}

function range(text, from, to) {
  let a = snap(text, from), b = snap(text, to);
  if (b < a) [a, b] = [b, a];
  return [a, b];
}

function explode(content) {
  const c = isContent(content) ? content : normalize(content);
  const chars = new Array(c.text.length);
  let i = 0;
  for (const r of c.runs) for (let k = 0; k < r.len; k++) chars[i++] = r.style;
  return { text: c.text, chars, paras: c.paras.map((p) => p.style), empty: c.text ? null : c.runs[0]?.style ?? {} };
}

function implode(text, chars, paras, empty = {}) {
  const runs = [];
  if (!text) runs.push({ len: 0, style: cleanChar(empty ?? chars[0] ?? {}) });
  else {
    let prevKey = null;
    const keys = new Map();
    for (let i = 0; i < text.length; i++) {
      const s = chars[i] ?? {};
      let entry = keys.get(s);
      if (!entry) {
        const clean = cleanChar(s);
        entry = { clean, key: stableKey(clean) };
        keys.set(s, entry);
      }
      if (entry.key === prevKey) runs[runs.length - 1].len++;
      else {
        runs.push({ len: 1, style: entry.clean });
        prevKey = entry.key;
      }
    }
  }
  const need = countNewlines(text) + 1;
  const ps = [];
  for (let i = 0; i < need; i++) ps.push({ style: cleanPara(paras[Math.min(i, paras.length - 1)] ?? {}) });
  return freezeContent({ v: 1, text, runs, paras: ps });
}

function freezeContent(c) {
  return freezeDeep(c);
}

function isContent(c) {
  if (!isObj(c) || c.v !== 1 || typeof c.text !== 'string' || !Array.isArray(c.runs) || !Array.isArray(c.paras)) return false;
  if (!Object.isFrozen(c)) return false; // only contents this module built skip normalize()
  return true;
}

/** Style of a caret at `at`: the character before it, at 0 the first character. */
function insertionStyle(ex, at) {
  if (!ex.text) return ex.empty ?? {};
  return ex.chars[at > 0 ? at - 1 : 0];
}

/** Index of the paragraph that holds character `index` (or a caret there). */
function paraOf(text, index) {
  let n = 0;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

/** First and last paragraph a range touches (a caret: its own). */
function paraSpan(text, from, to) {
  const first = paraOf(text, from);
  const last = to > from ? paraOf(text, to - 1) : first;
  return [first, last];
}

// ---------------------------------------------------------------------------------------------
// Building and reading

/** Plain text in one run and one paragraph style per paragraph. */
export function fromPlain(text, char = {}, para = {}) {
  const t = typeof text === 'string' ? text : String(text ?? '');
  const n = countNewlines(t) + 1;
  return implode(t, new Array(t.length).fill(char), new Array(n).fill(para), char);
}

export function plainText(content) {
  return isObj(content) && typeof content.text === 'string' ? content.text : '';
}

export function contentLength(content) {
  return plainText(content).length;
}

/**
 * Sound content from anything: merges equal neighbours, drops empty runs, fixes the run
 * coverage and the paragraph count, clamps to RANGES (never rounds), strips default keys and
 * moves run boundaries off the middle of surrogate pairs. Idempotent.
 */
export function normalize(content) {
  const c = isObj(content) ? content : {};
  const text = typeof c.text === 'string' ? c.text : '';
  const chars = new Array(text.length);
  const runs = Array.isArray(c.runs) ? c.runs.filter((r) => isObj(r) && finite(r.len) && r.len >= 0) : [];
  let i = 0, last = {};
  for (const r of runs) {
    const style = isObj(r.style) ? r.style : {};
    last = style;
    const len = Math.floor(r.len);
    for (let k = 0; k < len && i < text.length; k++) chars[i++] = style;
  }
  while (i < text.length) chars[i++] = last;
  // a run boundary inside a surrogate pair: the low half takes the high half's style
  for (let k = 1; k < text.length; k++) if (isHigh(text.charCodeAt(k - 1)) && isLow(text.charCodeAt(k))) chars[k] = chars[k - 1];
  const paras = (Array.isArray(c.paras) ? c.paras : []).map((p) => (isObj(p) && isObj(p.style) ? p.style : {}));
  if (!paras.length) paras.push({});
  const empty = runs.length ? (isObj(runs[0].style) ? runs[0].style : {}) : {};
  return implode(text, chars, paras, empty);
}

/** The resolved style of the character at index (the last one past the end). */
export function charStyleAt(content, index) {
  const ex = explode(content);
  if (!ex.text) return resolveChar(ex.empty);
  const i = Math.min(snap(ex.text, index), ex.text.length - 1);
  return resolveChar(ex.chars[i]);
}

export function paraIndexAt(content, index) {
  const text = plainText(content);
  return paraOf(text, snap(text, index));
}

/** Paragraphs: { index, from, to (excludes the '\n'), text, style (resolved) }. */
export function paragraphs(content) {
  const c = isContent(content) ? content : normalize(content);
  const out = [];
  let from = 0;
  const parts = c.text.split('\n');
  parts.forEach((t, index) => {
    out.push({ index, from, to: from + t.length, text: t, style: resolvePara(c.paras[index]?.style) });
    from += t.length + 1;
  });
  return out;
}

/** Runs clipped to [from, to): { from, to, style (resolved) }. */
export function runsIn(content, from = 0, to = Infinity) {
  const c = isContent(content) ? content : normalize(content);
  const [a, b] = range(c.text, from, to);
  const out = [];
  let pos = 0;
  for (const r of c.runs) {
    const s = pos, e = pos + r.len;
    pos = e;
    if (e <= a || s >= b) continue;
    out.push({ from: Math.max(s, a), to: Math.min(e, b), style: resolveChar(r.style) });
  }
  return out;
}

/** True when the content has one run and one paragraph style. */
export function isUniform(content) {
  const c = isContent(content) ? content : normalize(content);
  if (c.runs.length !== 1) return false;
  const k = stableKey(c.paras[0].style);
  return c.paras.every((p) => stableKey(p.style) === k);
}

/** Attribute keys any run / paragraph sets (PSD export decides from these, J.8). */
export function nonDefaultKeys(content) {
  const c = isContent(content) ? content : normalize(content);
  const char = new Set(), para = new Set();
  for (const r of c.runs) for (const k of Object.keys(r.style)) char.add(k);
  for (const p of c.paras) for (const k of Object.keys(p.style)) para.add(k);
  return { char: [...char], para: [...para] };
}

export function cloneContent(content) {
  return normalize(JSON.parse(JSON.stringify(isObj(content) ? content : {})));
}

/** Problems of a content object; [] when it is sound. */
export function validate(content) {
  const out = [];
  if (!isObj(content)) return ['not an object'];
  if (content.v !== 1) out.push('v is not 1');
  if (typeof content.text !== 'string') return [...out, 'text is not a string'];
  const text = content.text;
  if (!Array.isArray(content.runs)) out.push('runs is not an array');
  else {
    let sum = 0;
    content.runs.forEach((r, i) => {
      if (!isObj(r) || !Number.isInteger(r.len) || r.len < 0) out.push(`run ${i}: bad len`);
      else {
        if (r.len === 0 && !(text === '' && content.runs.length === 1)) out.push(`run ${i}: zero length`);
        if (!isObj(r.style)) out.push(`run ${i}: style is not an object`);
        sum += r.len;
        if (sum > 0 && sum < text.length && isHigh(text.charCodeAt(sum - 1)) && isLow(text.charCodeAt(sum))) out.push(`run ${i}: ends inside a surrogate pair`);
      }
    });
    if (sum !== text.length) out.push(`runs cover ${sum} of ${text.length} units`);
    if (text === '' && content.runs.length !== 1) out.push('an empty text needs exactly one run');
  }
  if (!Array.isArray(content.paras)) out.push('paras is not an array');
  else {
    const need = countNewlines(text) + 1;
    if (content.paras.length !== need) out.push(`paras: ${content.paras.length} for ${need} paragraphs`);
    content.paras.forEach((p, i) => { if (!isObj(p) || !isObj(p.style)) out.push(`para ${i}: style is not an object`); });
  }
  const styleProblems = (s, defaults, clean, label) => {
    if (!isObj(s)) return;
    for (const k of Object.keys(s)) {
      if (!(k in defaults)) continue;
      const v = clean(k, s[k]);
      if (v === undefined) out.push(`${label}: invalid ${k}`);
      else if (!deepEqual(v, s[k])) out.push(`${label}: ${k} out of range`);
    }
  };
  if (Array.isArray(content.runs)) content.runs.forEach((r, i) => styleProblems(r?.style, CHAR_DEFAULTS, cleanCharValue, `run ${i}`));
  if (Array.isArray(content.paras)) content.paras.forEach((p, i) => styleProblems(p?.style, PARA_DEFAULTS, cleanParaValue, `para ${i}`));
  return out;
}

// ---------------------------------------------------------------------------------------------
// Editing

/** Inserts str at `at` with `style` (sparse; default: the style of a caret at `at`). */
export function insertText(content, at, str, style) {
  const ex = explode(content);
  const s = typeof str === 'string' ? str : String(str ?? '');
  const pos = snap(ex.text, at);
  if (!s) return isContent(content) ? content : normalize(content);
  const st = style === undefined ? insertionStyle(ex, pos) : style;
  const text = ex.text.slice(0, pos) + s + ex.text.slice(pos);
  const chars = [...ex.chars.slice(0, pos), ...new Array(s.length).fill(st), ...ex.chars.slice(pos)];
  const p = paraOf(ex.text, pos);
  const k = countNewlines(s);
  const paras = [...ex.paras.slice(0, p + 1), ...new Array(k).fill(ex.paras[p]), ...ex.paras.slice(p + 1)];
  return implode(text, chars, paras, st);
}

/** Deletes [from, to); a deleted '\n' joins paragraphs and the first one's style wins. */
export function deleteRange(content, from, to) {
  const ex = explode(content);
  const [a, b] = range(ex.text, from, to);
  if (a === b) return isContent(content) ? content : normalize(content);
  const removed = ex.text.slice(a, b);
  const text = ex.text.slice(0, a) + ex.text.slice(b);
  const chars = [...ex.chars.slice(0, a), ...ex.chars.slice(b)];
  const p = paraOf(ex.text, a);
  const k = countNewlines(removed);
  const paras = [...ex.paras.slice(0, p + 1), ...ex.paras.slice(p + 1 + k)];
  // an emptied text keeps the style of what was deleted first as its insertion style
  return implode(text, chars, paras, text ? null : ex.chars[a]);
}

/**
 * Replaces [from, to) with str. The new text takes `style`, else the style of the first replaced
 * character (typing over a selection keeps its formatting), else, for an insertion, the style of
 * a caret at `from`.
 */
export function replaceRange(content, from, to, str, style) {
  const ex = explode(content);
  const [a, b] = range(ex.text, from, to);
  const st = style !== undefined ? style : b > a ? ex.chars[a] : insertionStyle(ex, a);
  const cut = deleteRange(content, a, b);
  return str ? insertText(cut, a, str, st) : cut;
}

/** The minimal replaceRange that turns plainText(content) into next (prefix and suffix kept). */
export function replacePlain(content, next) {
  const c = isContent(content) ? content : normalize(content);
  const cur = c.text;
  const n = typeof next === 'string' ? next : String(next ?? '');
  if (cur === n) return c;
  const max = Math.min(cur.length, n.length);
  let pre = 0;
  while (pre < max && cur.charCodeAt(pre) === n.charCodeAt(pre)) pre++;
  let suf = 0;
  while (suf < max - pre && cur.charCodeAt(cur.length - 1 - suf) === n.charCodeAt(n.length - 1 - suf)) suf++;
  // keep surrogate pairs whole on both sides
  if (pre > 0 && isHigh(cur.charCodeAt(pre - 1))) pre--;
  if (suf > 0 && isLow(cur.charCodeAt(cur.length - suf))) suf--;
  return replaceRange(c, pre, cur.length - suf, n.slice(pre, n.length - suf));
}

/** [from, to) as content of its own (formatted clipboard). */
export function sliceContent(content, from, to) {
  const ex = explode(content);
  const [a, b] = range(ex.text, from, to);
  const [p0, p1] = paraSpan(ex.text, a, b);
  const text = ex.text.slice(a, b);
  return implode(text, ex.chars.slice(a, b), ex.paras.slice(p0, p1 + 1), insertionStyle(ex, a));
}

/**
 * Inserts formatted content at `at`. Its characters keep their styles; a piece paragraph that is
 * complete in the result (ended by one of the piece's '\n', or starting where the target
 * paragraph starts) keeps its paragraph style, the partial ones join the target paragraph's.
 */
export function insertContent(content, at, piece) {
  const ex = explode(content);
  const pc = explode(piece);
  const pos = snap(ex.text, at);
  if (!pc.text) return isContent(content) ? content : normalize(content);
  const text = ex.text.slice(0, pos) + pc.text + ex.text.slice(pos);
  const chars = [...ex.chars.slice(0, pos), ...pc.chars, ...ex.chars.slice(pos)];
  const p = paraOf(ex.text, pos);
  const k = countNewlines(pc.text);
  const target = ex.paras[p];
  const atStart = pos === 0 || ex.text.charCodeAt(pos - 1) === 10;
  const added = [];
  // paragraphs p .. p + k of the result
  for (let i = 0; i <= k; i++) {
    if (i === k) added.push(k === 0 ? target : target); // the last piece part joins the text after it
    else if (i === 0) added.push(atStart ? pc.paras[0] : target);
    else added.push(pc.paras[i]);
  }
  const paras = [...ex.paras.slice(0, p), ...added, ...ex.paras.slice(p + 1)];
  return implode(text, chars, paras, null);
}

/** Applies a character patch to [from, to); a caret (from === to) changes nothing. */
export function applyChar(content, from, to, patch) {
  const ex = explode(content);
  const [a, b] = range(ex.text, from, to);
  if (a === b) return isContent(content) ? content : normalize(content);
  const cache = new Map();
  const chars = ex.chars.slice();
  for (let i = a; i < b; i++) {
    const s = chars[i];
    let n = cache.get(s);
    if (!n) cache.set(s, (n = patchStyle(s, patch)));
    chars[i] = n;
  }
  return implode(ex.text, chars, ex.paras, null);
}

/** Applies a paragraph patch to every paragraph [from, to] touches (a caret: its paragraph). */
export function applyPara(content, from, to, patch) {
  const ex = explode(content);
  const [a, b] = range(ex.text, from, to);
  const [p0, p1] = paraSpan(ex.text, a, b);
  const paras = ex.paras.slice();
  for (let i = p0; i <= p1; i++) paras[i] = patchStyle(paras[i], patch);
  return implode(ex.text, ex.chars, paras, ex.empty);
}

/** Forces a run boundary at index (no visible change; the result is not merged back). */
export function splitAt(content, index) {
  const c = isContent(content) ? content : normalize(content);
  const i = snap(c.text, index);
  if (i <= 0 || i >= c.text.length) return c;
  const runs = [];
  let pos = 0;
  for (const r of c.runs) {
    if (i > pos && i < pos + r.len) runs.push({ len: i - pos, style: r.style }, { len: pos + r.len - i, style: r.style });
    else runs.push(r);
    pos += r.len;
  }
  return freezeContent({ v: 1, text: c.text, runs, paras: c.paras });
}

/** fn(style, resolved) -> style for every run. */
export function mapChar(content, fn) {
  const c = isContent(content) ? content : normalize(content);
  return normalize({ ...c, runs: c.runs.map((r) => ({ len: r.len, style: fn(cloneValue(r.style), resolveChar(r.style)) ?? {} })) });
}

/** fn(style, resolved) -> style for every paragraph. */
export function mapPara(content, fn) {
  const c = isContent(content) ? content : normalize(content);
  return normalize({ ...c, paras: c.paras.map((p) => ({ style: fn(cloneValue(p.style), resolvePara(p.style)) ?? {} })) });
}

/** Scales every length (size, px leading, baseline shift, stroke width, indents, spaces, tab stop, hyphenation zone) by s. */
export function scaleContent(content, s) {
  const k = finite(s) && s > 0 ? s : 1;
  const sc = mapChar(content, (style, r) => {
    const out = { ...style, size: r.size * k };
    if (r.leading !== 'auto') out.leading = r.leading * k;
    if (r.baselineShift) out.baselineShift = r.baselineShift * k;
    if (r.stroke) out.stroke = { ...r.stroke, width: r.stroke.width * k };
    return out;
  });
  return mapPara(sc, (style, r) => {
    const out = { ...style };
    for (const key of ['indentLeft', 'indentRight', 'indentFirst', 'spaceBefore', 'spaceAfter']) if (r[key]) out[key] = r[key] * k;
    out.tabStop = r.tabStop * k;
    if (style.hyphenation || k !== 1) out.hyphenation = { ...r.hyphenation, zone: r.hyphenation.zone * k };
    return out;
  });
}

// ---------------------------------------------------------------------------------------------
// Attribute queries

function mergeMixed(values, deep) {
  const first = values[0];
  if (values.every((v) => deepEqual(v, first))) return cloneValue(first);
  if (!deep) return MIXED;
  if (Array.isArray(first) && values.every((v) => Array.isArray(v) && v.length === first.length)) {
    return first.map((_, i) => mergeMixed(values.map((v) => v[i]), deep));
  }
  if (isObj(first) && values.every(isObj)) {
    const keys = new Set();
    for (const v of values) for (const k of Object.keys(v)) keys.add(k);
    const out = {};
    for (const k of keys) out[k] = mergeMixed(values.map((v) => v[k]), deep);
    return out;
  }
  return MIXED;
}

function attrs(styles, keys, deep) {
  const out = {};
  for (const k of keys) out[k] = mergeMixed(styles.map((s) => s[k]), deep);
  return out;
}

/** Resolved character attributes of [from, to) (a caret: its insertion style); MIXED where they differ. */
export function charAttrs(content, from, to, { deep = false } = {}) {
  const ex = explode(content);
  const [a, b] = range(ex.text, from, to);
  if (a === b) return resolveChar(insertionStyle(ex, a));
  const seen = new Map();
  for (let i = a; i < b; i++) if (!seen.has(ex.chars[i])) seen.set(ex.chars[i], resolveChar(ex.chars[i]));
  const styles = [...seen.values()];
  const keys = new Set(CHAR_KEYS);
  for (const s of styles) for (const k of Object.keys(s)) keys.add(k);
  return attrs(styles, [...keys], deep);
}

/** Resolved paragraph attributes of the paragraphs [from, to] touches; MIXED where they differ. */
export function paraAttrs(content, from, to, { deep = false } = {}) {
  const ex = explode(content);
  const [a, b] = range(ex.text, from, to);
  const [p0, p1] = paraSpan(ex.text, a, b);
  const styles = ex.paras.slice(p0, p1 + 1).map(resolvePara);
  const keys = new Set(PARA_KEYS);
  for (const s of styles) for (const k of Object.keys(s)) keys.add(k);
  return attrs(styles, [...keys], deep);
}

// ---------------------------------------------------------------------------------------------
// 0.3 compatibility (TextLayer.font, .pigment version 2)

const ulp = (x) => (x === 0 ? Number.MIN_VALUE : 2 ** (Math.floor(Math.log2(Math.abs(x))) - 52));
/**
 * The shortest decimal within a few ulps of x. Converting 0.3's letterSpacing (px) to tracking
 * (1/1000 em) and back multiplies and divides by the size, which can leave x one or two ulps off;
 * every value a person typed (0.5 at size 7, 1.5 line height) comes back bit for bit, an arbitrary
 * float at most a few ulps away.
 */
function tidy(x) {
  if (!Number.isFinite(x) || x === 0) return x;
  const tol = 4 * ulp(x);
  for (let p = 1; p <= 16; p++) {
    const r = Number(x.toPrecision(p));
    if (Math.abs(r - x) <= tol) return r;
  }
  return x;
}
/** tidy() for the engines: 0.3's px letter spacing and line-height factor exactly as legacyFont reports them. */
export const tidyNumber = tidy;

/** A 0.3 text layer ({ text, font }) as content and type options (see ARCHITECTURE.md, A). */
export function fromLegacy({ text = '', font = {} } = {}) {
  const f = isObj(font) ? font : {};
  const char = {};
  if (f.family !== undefined) char.fontFamily = f.family;
  if (f.weight !== undefined) char.fontWeight = f.weight;
  if (f.italic !== undefined) char.fontItalic = !!f.italic;
  if (f.size !== undefined) char.size = f.size;
  if (f.color !== undefined) char.color = f.color;
  if (f.underline !== undefined) char.underline = !!f.underline;
  if (f.stroke !== undefined) char.stroke = f.stroke ? { color: f.stroke.color, width: f.stroke.width } : null;
  const size = finite(f.size) && f.size > 0 ? f.size : CHAR_DEFAULTS.size;
  if (finite(f.letterSpacing) && f.letterSpacing) char.tracking = (f.letterSpacing * 1000) / size;
  const para = { composer: 'single', breakRules: 'legacy' };
  if (f.align !== undefined) para.align = f.align;
  // tidied: 1.2 x 100 is 120.00000000000001, which would store a justification on every 0.3 paragraph
  if (finite(f.lineHeight)) para.justification = { ...JUSTIFICATION_DEFAULTS, autoLeading: tidy(f.lineHeight * 100) };
  const typeOptions = {};
  if (f.orientation && f.orientation !== 'horizontal') typeOptions.orientation = f.orientation;
  return { content: fromPlain(typeof text === 'string' ? text : String(text ?? ''), char, para), typeOptions: normalizeTypeOptions(typeOptions) };
}

const LAST_LINE = { 'justify-left': 'left', 'justify-center': 'center', 'justify-right': 'right', 'justify-all': 'left' };

/** The flat 0.3 font object of the first character, paragraph 0 and the type options. */
export function legacyFont(content, typeOptions = {}) {
  const ch = charStyleAt(content, 0);
  const para = resolvePara(isContent(content) ? content.paras[0]?.style : normalize(content).paras[0]?.style);
  const font = {
    family: ch.fontFamily,
    size: ch.size,
    weight: ch.fontWeight,
    italic: ch.fontItalic,
    underline: ch.underline,
    color: ch.color,
    align: LAST_LINE[para.align] ?? para.align,
    lineHeight: tidy(ch.leading === 'auto' ? para.justification.autoLeading / 100 : ch.leading / ch.size),
    letterSpacing: tidy((ch.tracking * ch.size) / 1000),
    stroke: ch.stroke ? { ...ch.stroke } : null,
  };
  const orientation = isObj(typeOptions) ? typeOptions.orientation : undefined;
  if (orientation && orientation !== 'horizontal') font.orientation = orientation;
  return font;
}

/** Layer-level type options with defaults filled in and invalid values replaced. */
export function normalizeTypeOptions(opts) {
  const o = isObj(opts) ? opts : {};
  return {
    ...o,
    orientation: ENUMS.orientation.includes(o.orientation) ? o.orientation : TYPE_OPTION_DEFAULTS.orientation,
    antiAlias: typeof o.antiAlias === 'string' && o.antiAlias ? o.antiAlias : TYPE_OPTION_DEFAULTS.antiAlias,
    systemLayout: typeof o.systemLayout === 'boolean' ? o.systemLayout : TYPE_OPTION_DEFAULTS.systemLayout,
  };
}
