// Line-break opportunities for type-paragraph-panel (ARCHITECTURE.md "0.4 features", package 4; B.2 registerBreaker):
// the Unicode Line Breaking Algorithm (UAX 14, Unicode 16.0) for paragraphs whose breakRules is 'standard', and 0.3's
// rule (after every U+0020, nowhere else) for 'legacy', which the version 2 upgrade writes so old paragraphs keep
// their lines. Pure: no DOM, so Node tests import it.
//
// The classes come from lib/type/patterns/line-break.js (Unicode's LineBreak.txt; licence in its header). Two inputs
// UAX 14 asks for are approximated: East_Asian_Width (only LB21a, LB30 and LB19a use it) by the wide and fullwidth
// blocks, and dictionary breaks inside Thai, Lao, Khmer and Myanmar text (class SA) by Intl.Segmenter's word
// boundaries, which use the same ICU dictionaries as browsers.
import { CLASSES, RUNS } from './patterns/line-break.js';

const C = Object.fromEntries(CLASSES.map((c, i) => [c, i]));
const {
  XX, AI, AK, AL, AP, AS, B2, BA, BB, BK, CB, CJ, CL, CM, CP, CR, EB, EM, EX, GL, H2, H3, HL, HY, ID, IN, IS, JL, JT, JV,
  LF, NL, NS, NU, OP, PO, PR, QU, RI, SA, SG, SP, SY, VF, VI, WJ, ZW, ZWJ,
} = C;

// ---- the class table ---------------------------------------------------------------------------------------------------

let starts = null; // Uint32Array of run starts
let runClass = null; // Uint8Array
let bmp = null; // Uint8Array(0x10000): the class of every BMP code point (most text never leaves it)

function load() {
  if (starts) return;
  const parts = RUNS.split(',');
  starts = new Uint32Array(parts.length);
  runClass = new Uint8Array(parts.length);
  let cp = 0;
  parts.forEach((p, i) => {
    const [d, c] = p.split('.');
    cp += parseInt(d, 36);
    starts[i] = cp;
    runClass[i] = parseInt(c, 36);
  });
  bmp = new Uint8Array(0x10000);
  for (let i = 0; i < starts.length && starts[i] < 0x10000; i++) {
    const end = Math.min(0x10000, i + 1 < starts.length ? starts[i + 1] : 0x110000);
    bmp.fill(runClass[i], starts[i], end);
  }
}

/** The Line_Break class of a code point, as its two- or three-letter name ('AL', 'SP', 'ZWJ'). */
export function lineBreakClass(cp) {
  return CLASSES[classIndex(cp)];
}

function classIndex(cp) {
  load();
  if (cp < 0x10000) return bmp[cp];
  let lo = 0, hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= cp) lo = mid;
    else hi = mid - 1;
  }
  return runClass[lo];
}

// East_Asian_Width F, W or H, approximated by blocks (UAX 14 reads it in LB19a, LB21a and LB30 only)
const EA_RANGES = [[0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xa960, 0xa97f], [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe10, 0xfe19], [0xfe30, 0xfe6f], [0xff00, 0xff60], [0xffe0, 0xffe6], [0x1f300, 0x1f64f], [0x1f900, 0x1f9ff], [0x20000, 0x2fffd], [0x30000, 0x3fffd]];
function eastAsian(cp) {
  for (const [a, b] of EA_RANGES) if (cp >= a && cp <= b) return true;
  return false;
}
const PI = /\p{Pi}/u, PF = /\p{Pf}/u, MARK = /[\p{Mn}\p{Mc}]/u, EXT_PICT_UNASSIGNED = /(?=\p{Extended_Pictographic})\p{Cn}/u;
const DOTTED_CIRCLE = 0x25cc;

// ---- the algorithm -------------------------------------------------------------------------------------------------------

/** 0.3's breaks: after every U+0020, mandatory after U+2028 (B.6). */
export function legacyBreaks(text) {
  const out = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === ' ') out.push({ at: i + 1, kind: 'space' });
    else if (text[i] === ' ') out.push({ at: i + 1, kind: 'mandatory' });
  }
  return out;
}

const segmenters = new Map();
function wordSegmenter(lang) {
  const key = lang || 'th';
  if (!segmenters.has(key)) {
    let s = null;
    try {
      s = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter(key, { granularity: 'word' }) : null;
    } catch {
      s = new Intl.Segmenter('th', { granularity: 'word' });
    }
    segmenters.set(key, s);
  }
  return segmenters.get(key);
}

/**
 * The breaker registered with the facade (B.2): break opportunities of the whole text, { at, kind } with `at` the
 * UTF-16 index a line may start at. kind: 'mandatory' (after U+2028, line and paragraph separators), 'space' (after
 * spaces), 'hyphen' (after a hyphen, a soft hyphen or a dash that breaks after), 'other' (between ideographs, after a
 * slash, inside Thai...). `rules` 'legacy' gives 0.3's breaks.
 */
export function lineBreaks(text, lang = 'en-US', { rules = 'standard' } = {}) {
  if (rules === 'legacy') return legacyBreaks(text);
  const cps = [];
  const at = []; // UTF-16 index of each code point
  for (let i = 0; i < text.length;) {
    const cp = text.codePointAt(i);
    cps.push(cp);
    at.push(i);
    i += cp > 0xffff ? 2 : 1;
  }
  const n = cps.length;
  if (!n) return [];
  // LB1: resolve AI, SG, XX to AL; SA to CM (marks) or AL; CJ to NS (UAX 14's default, "strict" Japanese)
  const raw = new Uint8Array(n);
  const cls = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const c = classIndex(cps[i]);
    raw[i] = c;
    let r = c;
    if (c === AI || c === SG || c === XX) r = AL;
    else if (c === SA) r = MARK.test(String.fromCodePoint(cps[i])) ? CM : AL;
    else if (c === CJ) r = NS;
    cls[i] = r;
  }
  // dictionary breaks inside runs of SA characters
  const saBreak = new Uint8Array(n + 1);
  for (let i = 0; i < n;) {
    if (raw[i] !== SA) {
      i++;
      continue;
    }
    let j = i;
    while (j < n && raw[j] === SA) j++;
    const seg = wordSegmenter(lang);
    if (seg) {
      const s = text.slice(at[i], j < n ? at[j] : text.length);
      for (const part of seg.segment(s)) {
        if (part.index === 0) continue;
        const k = at.indexOf(at[i] + part.index, i);
        if (k > i && k < j) saBreak[k] = 1;
      }
    }
    i = j;
  }
  // LB9 / LB10: a combining mark or ZWJ takes the class of the character it follows (except after spaces and breaks);
  // alone it is AL. `eff` is the class the pair rules see; `absorbed` marks the characters attached to their base.
  const eff = new Uint8Array(n);
  const absorbed = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const c = cls[i];
    if (c === CM || c === ZWJ) {
      if (i > 0 && ![BK, CR, LF, NL, SP, ZW].includes(eff[i - 1])) {
        eff[i] = eff[i - 1];
        absorbed[i] = 1;
      } else eff[i] = AL;
    } else eff[i] = c;
  }
  // the index of the character before i that is not attached to its predecessor (the base the pair rules use)
  const baseBefore = (i) => {
    let j = i - 1;
    while (j > 0 && absorbed[j]) j--;
    return j;
  };
  const skipSpacesBack = (i) => {
    let j = baseBefore(i);
    while (j >= 0 && eff[j] === SP) j = j > 0 ? baseBefore(j) : -1;
    return j;
  };
  const nextBase = (i) => {
    let j = i + 1;
    while (j < n && absorbed[j]) j++;
    return j;
  };

  const out = [];
  for (let i = 1; i < n; i++) {
    const verdict = decide(i);
    if (!verdict) continue;
    let kind = verdict;
    if (kind === 'break') {
      const p = cls[i - 1], cp = cps[i - 1];
      if (p === SP || eff[baseBefore(i)] === SP) kind = 'space';
      else if (p === HY || cp === 0x2010 || cp === 0x00ad || (p === BA && (cp === 0x2013 || cp === 0x2012 || cp === 0x2014))) kind = 'hyphen';
      else kind = 'other';
    }
    out.push({ at: at[i], kind });
  }
  return out;

  // 'mandatory', 'break' or null (no break) for the boundary before code point i
  function decide(i) {
    const pr = cls[i - 1], cu = cls[i];
    // LB4, LB5: after hard breaks; CR × LF
    if (pr === BK || pr === LF || pr === NL) return 'mandatory';
    if (pr === CR) return cu === LF ? null : 'mandatory';
    // LB6, LB7
    if (cu === BK || cu === CR || cu === LF || cu === NL || cu === SP || cu === ZW) return null;
    // LB8: ZW SP* ÷
    {
      let j = i - 1;
      while (j >= 0 && cls[j] === SP) j--;
      if (j >= 0 && cls[j] === ZW) return 'break';
    }
    // LB8a: ZWJ ×
    if (pr === ZWJ) return null;
    // LB9: X (CM | ZWJ)* is X
    if (absorbed[i]) return null;
    const ib = baseBefore(i);
    const a = eff[ib], b = eff[i];
    const bcp = cps[i], acp = cps[ib];
    // dictionary breaks between two SA characters
    if (raw[ib] === SA && raw[i] === SA) return saBreak[i] ? 'break' : null;
    // LB11
    if (a === WJ || b === WJ) return null;
    // LB12, LB12a
    if (a === GL) return null;
    if (b === GL && a !== SP && a !== BA && a !== HY) return null;
    // LB13
    if (b === CL || b === CP || b === EX || b === SY) return null;
    // LB14: OP SP* ×
    const sb = skipSpacesBack(i);
    if (sb >= 0 && eff[sb] === OP) return null;
    // LB15a: (sot | BK | CR | LF | NL | OP | QU | GL | SP | ZW) [QU & Pi] SP* ×
    if (sb >= 0 && eff[sb] === QU && PI.test(String.fromCodePoint(cps[sb]))) {
      const before = sb > 0 ? eff[baseBefore(sb)] : -1;
      if (before === -1 || [BK, CR, LF, NL, OP, QU, GL, SP, ZW].includes(before)) return null;
    }
    // LB15b: × [QU & Pf] ( SP | GL | WJ | CL | QU | CP | EX | IS | SY | BK | CR | LF | NL | ZW | eot )
    if (b === QU && PF.test(String.fromCodePoint(bcp))) {
      const nx = nextBase(i);
      if (nx >= n || [SP, GL, WJ, CL, QU, CP, EX, IS, SY, BK, CR, LF, NL, ZW].includes(eff[nx])) return null;
    }
    // LB15c: SP ÷ IS NU; LB15d: × IS
    if (a === SP && b === IS && nextBase(i) < n && eff[nextBase(i)] === NU) return 'break';
    if (b === IS) return null;
    // LB16: (CL | CP) SP* × NS
    if (b === NS && sb >= 0 && (eff[sb] === CL || eff[sb] === CP)) return null;
    // LB17: B2 SP* × B2
    if (b === B2 && sb >= 0 && eff[sb] === B2) return null;
    // LB18: SP ÷
    if (a === SP) return 'break';
    // LB19, LB19a: no break around quotation marks, except between East Asian characters and a quote
    if (b === QU) {
      if (!PI.test(String.fromCodePoint(bcp))) return null;
      if (!eastAsian(acp)) return null;
      const nx = nextBase(i);
      if (nx >= n || !eastAsian(cps[nx])) return null;
    }
    if (a === QU) {
      if (!PF.test(String.fromCodePoint(acp))) return null;
      if (!eastAsian(bcp)) return null;
      const pb = ib > 0 ? baseBefore(ib) : -1;
      if (pb < 0 || !eastAsian(cps[pb])) return null;
    }
    // LB20: ÷ CB, CB ÷
    if (a === CB || b === CB) return 'break';
    // LB20a: ( sot | BK | CR | LF | NL | SP | ZW | CB | GL ) ( HY | U+2010 ) × ( AL | HL )
    if ((a === HY || acp === 0x2010) && (b === AL || b === HL)) {
      const pb = ib > 0 ? eff[baseBefore(ib)] : -1;
      if (pb === -1 || [BK, CR, LF, NL, SP, ZW, CB, GL].includes(pb)) return null;
    }
    // LB21: × BA, × HY, × NS, BB ×
    if (b === BA || b === HY || b === NS || a === BB) return null;
    // LB21a: HL ( HY | [ BA - EastAsian ] ) × [^HL]
    if ((a === HY || (a === BA && !eastAsian(acp))) && b !== HL && ib > 0 && eff[baseBefore(ib)] === HL) return null;
    // LB21b: SY × HL
    if (a === SY && b === HL) return null;
    // LB22: × IN
    if (b === IN) return null;
    // LB23, LB23a, LB24
    if ((a === AL || a === HL) && b === NU) return null;
    if (a === NU && (b === AL || b === HL)) return null;
    if (a === PR && (b === ID || b === EB || b === EM)) return null;
    if ((a === ID || a === EB || a === EM) && b === PO) return null;
    if ((a === PR || a === PO) && (b === AL || b === HL)) return null;
    if ((a === AL || a === HL) && (b === PR || b === PO)) return null;
    // LB25: numbers (the pair form: prefix, infix and postfix stay with their digits)
    if ((a === CL || a === CP || a === NU) && (b === PO || b === PR)) return null;
    if ((a === PO || a === PR) && (b === OP || b === NU)) return null;
    if ((a === HY || a === IS || a === NU || a === SY) && b === NU) return null;
    if ((a === PO || a === PR) && b === HY && nextBase(i) < n && eff[nextBase(i)] === NU) return null;
    if ((a === OP || a === HY) && b === NU) return null;
    // LB26, LB27: Korean syllable blocks
    if (a === JL && (b === JL || b === JV || b === H2 || b === H3)) return null;
    if ((a === JV || a === H2) && (b === JV || b === JT)) return null;
    if ((a === JT || a === H3) && b === JT) return null;
    if ((a === JL || a === JV || a === JT || a === H2 || a === H3) && b === PO) return null;
    if (a === PR && (b === JL || b === JV || b === JT || b === H2 || b === H3)) return null;
    // LB28: (AL | HL) × (AL | HL)
    if ((a === AL || a === HL) && (b === AL || b === HL)) return null;
    // LB28a: Brahmic orthographic syllables
    const ak = (k, c) => c === AK || c === AS || cps[k] === DOTTED_CIRCLE;
    if (a === AP && ak(i, b)) return null;
    if (ak(ib, a) && (b === VF || b === VI)) return null;
    if (a === VI && ak(i, b) && ib > 0 && ak(baseBefore(ib), eff[baseBefore(ib)])) return null;
    if (ak(ib, a) && ak(i, b) && nextBase(i) < n && eff[nextBase(i)] === VF) return null;
    // LB29: IS × (AL | HL)
    if (a === IS && (b === AL || b === HL)) return null;
    // LB30: (AL | HL | NU) × [OP - EastAsian]; [CP - EastAsian] × (AL | HL | NU)
    if ((a === AL || a === HL || a === NU) && b === OP && !eastAsian(bcp)) return null;
    if (a === CP && !eastAsian(acp) && (b === AL || b === HL || b === NU)) return null;
    // LB30a: regional indicators pair up
    if (a === RI && b === RI) {
      let count = 0;
      for (let j = ib; j >= 0 && eff[j] === RI; j = j > 0 ? baseBefore(j) : -1) {
        if (!absorbed[j]) count++;
        if (j === 0) break;
      }
      if (count % 2 === 1) return null;
    }
    // LB30b: EB × EM; [ExtPict & Cn] × EM
    if (b === EM && (a === EB || EXT_PICT_UNASSIGNED.test(String.fromCodePoint(acp)))) return null;
    // LB31
    return 'break';
  }
}

/** The breaker for registerBreaker: (text, lang, { rules }) -> Break[]. */
export function breaker(text, lang, opts = {}) {
  return lineBreaks(text, lang, opts);
}
