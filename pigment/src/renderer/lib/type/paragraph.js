// Paragraph composition for type-paragraph-panel (ARCHITECTURE.md "0.4 features", package 4; B.2, B.3): Adobe's two
// composers (Single-line: greedy with Photoshop's cost rules; Every-line: Knuth and Plass's total-fit line breaking),
// justification (word and letter spacing, glyph scaling, single-word lines), hyphenation limits (consecutive hyphens,
// hyphenation zone, last word), Roman hanging punctuation and the list formatter. Pure: no DOM, so Node tests import
// it. The engines call `compose(input)` per paragraph segment and apply what it returns (B.3 Composer).
//
// Units: everything is in document pixels, as the engines measure. Justification percentages are those of
// Photoshop's Justification dialog: word spacing in % of the space's width, letter spacing in % of the space's width
// added between glyphs, glyph scaling in % of the glyphs' width.

// The engines of 0.4 clamp a composer's `wordSpace` at 0 (lib/type/api.js canvasLayout, lib/type/layout.js), so word
// spaces cannot shrink below their natural width. Until they accept negative values, the part of a compression that
// belongs to the spaces is spread over the letter gaps instead (the line still ends flush). Flip to true once the
// engines take negative word spacing (integrator: drop the Math.max(0, …) on wordSpace in both engines).
export const SPACES_SHRINK = false;

const SPACE = ' ';
const isTrailingSpace = (ch) => ch === ' ' || ch === '　';
const LETTER_RUN = /[\p{L}\p{M}'’]+/gu;

// Roman hanging punctuation (Photoshop): these hang wholly outside the margins, the second set half
const HANG_FULL = new Set([...'.,\'"‘’“”‚„‹›«»-‐‑­']);
const HANG_HALF = new Set([...':;–—…*~']);

/** The fraction of a character's width that hangs into the margin (1, 0.5 or 0). */
export function hangFraction(ch) {
  if (HANG_FULL.has(ch)) return 1;
  if (HANG_HALF.has(ch)) return 0.5;
  return 0;
}

// cost parameters (TeX's, which the Every-line Composer's behaviour matches closely)
const LINE_PENALTY = 10;
const HYPHEN_PENALTY = 50;
const EXPLICIT_HYPHEN_PENALTY = 50;
const DOUBLE_HYPHEN_DEMERITS = 3000;
const FINAL_HYPHEN_DEMERITS = 5000;
const FITNESS_DEMERITS = 3000;
const PRETOLERANCE = 100;
const TOLERANCE = 200;
const EMERGENCY_PENALTY = 1000; // a break inside a word too long for the line (no hyphen drawn)

const isJustified = (align) => typeof align === 'string' && align.startsWith('justify');

/** True when a paragraph style asks for nothing 0.3 did not do: then 0.3's greedy lines are kept exactly. */
export function isLegacyParagraph(style) {
  const j = style.justification ?? {};
  return style.breakRules === 'legacy'
    && style.composer !== 'every'
    && !isJustified(style.align)
    && !style.hyphenate
    && !style.hangingPunctuation
    && (j.word?.[1] ?? 100) === 100
    && (j.letter?.[1] ?? 0) === 0
    && (j.glyph?.[1] ?? 100) === 100;
}

// ---- 0.3's greedy composer (the stub's, B.6), kept for paragraphs that ask for nothing more -----------------------------

/**
 * 0.3's greedy first fit over the words of a paragraph (split at U+0020): a word that does not fit starts a new line,
 * the one space at the break is consumed, double spaces stay in the line, and a line's leading empty words (spaces) are
 * dropped as 0.3 dropped them. Identical to the skeleton's stub composer, which it replaces.
 */
export function legacyGreedy({ from, to, text, lineWidth, measure }) {
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
}

// ---- shared preparation ---------------------------------------------------------------------------------------------------

/** Justification settings as fractions: { word: [min, des, max] (×space), letter (×space), glyph (×1), singleWord }. */
function spacing(style) {
  const j = style.justification ?? {};
  const tri = (v, d) => (Array.isArray(v) && v.length === 3 ? v.map((x) => Number(x) / 100) : d);
  return {
    word: tri(j.word, [0.8, 1, 1.33]),
    letter: tri(j.letter, [0, 0, 0]),
    glyph: tri(j.glyph, [1, 1, 1]),
    singleWord: j.singleWord ?? 'justify-all',
  };
}

/**
 * Break candidates of a segment, in order: the breaker's opportunities, hyphenation points when the paragraph
 * hyphenates (and `withHyphens`), breaks inside words too long for any line (`emergency`) and the segment end.
 * { at, kind: 'space' | 'hyphen' | 'other' | 'mandatory' | 'auto' | 'emergency' | 'end', hyphen (a '-' is drawn),
 *   flagged (counts as a hyphenated line), penalty, wordStart? }
 */
function candidates(ctx, { withHyphens, emergency }) {
  const { from, to, text, input } = ctx;
  const out = [];
  for (const b of input.breaks ?? []) {
    if (b.at <= from || b.at >= to) continue;
    // after a run of spaces only (0.3's rules break after each one; a line never starts with a space of the run)
    if (b.kind === 'space' && text[b.at] === SPACE) continue;
    const shy = text[b.at - 1] === '­';
    if (b.kind === 'mandatory') out.push({ at: b.at, kind: 'mandatory', hyphen: false, flagged: false, penalty: -Infinity });
    else if (b.kind === 'hyphen' || shy) out.push({ at: b.at, kind: 'hyphen', hyphen: shy, flagged: true, penalty: shy ? HYPHEN_PENALTY : EXPLICIT_HYPHEN_PENALTY, shy });
    else out.push({ at: b.at, kind: b.kind === 'space' ? 'space' : 'other', hyphen: false, flagged: false, penalty: 0 });
  }
  const taken = new Set(out.map((c) => c.at));
  const words = [];
  if ((withHyphens && input.hyphenate) || emergency) {
    LETTER_RUN.lastIndex = 0;
    const seg = text.slice(from, to);
    let m;
    while ((m = LETTER_RUN.exec(seg))) words.push([from + m.index, from + m.index + m[0].length]);
  }
  if (withHyphens && input.hyphenate) {
    const hy = ctx.style.hyphenation ?? {};
    const lastWord = words[words.length - 1];
    for (const [ws, we] of words) {
      // Hyphenate Last Word off: the paragraph's last word stays whole (only in the paragraph's last segment)
      if (hy.lastWord === false && lastWord && ws === lastWord[0] && ctx.lastSegment) continue;
      let pos;
      try {
        pos = input.hyphenate(ws, we) ?? [];
      } catch {
        pos = [];
      }
      for (const p of pos) {
        if (p <= ws || p >= we || taken.has(p)) continue;
        taken.add(p);
        out.push({ at: p, kind: 'auto', hyphen: true, flagged: true, penalty: HYPHEN_PENALTY, wordStart: ws });
      }
    }
  }
  if (emergency) {
    // a word wider than the narrowest line may break anywhere (Photoshop breaks it rather than letting it stick out)
    const narrow = Math.max(1, Math.min(input.lineWidth(0), input.lineWidth(1)));
    for (const [ws, we] of words) {
      if (input.measure(ws, we) <= narrow) continue;
      for (let i = ws + 1; i < we; i++) {
        if (taken.has(i) || isLowSurrogate(text.charCodeAt(i)) || /\p{M}/u.test(text[i])) continue;
        taken.add(i);
        out.push({ at: i, kind: 'emergency', hyphen: false, flagged: false, penalty: EMERGENCY_PENALTY });
      }
    }
  }
  out.sort((a, b) => a.at - b.at);
  out.push({ at: to, kind: 'end', hyphen: false, flagged: false, penalty: -Infinity });
  return out;
}
const isLowSurrogate = (c) => c >= 0xdc00 && c <= 0xdfff;

function makeContext(input, opts = {}) {
  const { from, to, text } = input;
  const style = input.style ?? {};
  const sp = spacing(style);
  const justified = isJustified(style.align);
  const cache = new Map();
  const N = text.length + 1;
  const measure = (a, b) => {
    if (b <= a) return 0;
    const k = a * N + b;
    let w = cache.get(k);
    if (w === undefined) {
      w = Number(input.measure(a, b)) || 0;
      cache.set(k, w);
    }
    return w;
  };
  // the natural width of a space in the paragraph (letter spacing is in % of it; a line without spaces uses it too)
  let space = 0;
  for (let i = from; i < to && !space; i++) if (text[i] === SPACE) space = Number(input.spaceWidth?.(i)) || 0;
  if (!space) space = Math.max(1, (Number(input.hyphenWidth?.(Math.min(to, from + 1))) || 4) * 0.9);
  // a segment that ends with a forced line break (U+2028) is not the paragraph's end: its last line is justified as
  // the engines justify it (B.3: only a paragraph's last line keeps its alignment)
  const lastSegment = opts.lastSegment ?? text[to] !== '\u2028';
  return { input, from, to, text, style, sp, justified, measure, space, lastSegment };
}

/**
 * What a line [a, c.at) needs: natural width (spaces at the end hang), the count of spaces and glyph gaps, its
 * available width (indents applied by the engine through lineWidth; hanging punctuation added), and its desired width
 * with stretch and shrink by the justification settings.
 */
function lineInfo(ctx, a, c, lineNo) {
  const { text, input, sp, space } = ctx;
  let e = c.at;
  while (e > a && isTrailingSpace(text[e - 1])) e--;
  const natural = ctx.measure(a, e);
  const hyph = c.hyphen ? Number(input.hyphenWidth(c.at)) || 0 : 0;
  let S = 0, spaceSum = 0, G = 0;
  for (let i = a; i < e; i++) {
    const code = text.charCodeAt(i);
    if (isLowSurrogate(code)) continue;
    G++;
    if (text[i] === SPACE) {
      S++;
      spaceSum += Number(input.spaceWidth?.(i)) || space;
    }
  }
  G = Math.max(0, G - 1);
  const sw = S ? spaceSum / S : space; // the line's mean space width
  let hangStart = 0, hangEnd = 0;
  if (ctx.style.hangingPunctuation && e > a) {
    const f0 = hangFraction(text[a]);
    if (f0) hangStart = ctx.measure(a, a + 1) * f0;
    if (c.hyphen) hangEnd = hyph;
    else {
      const f1 = hangFraction(text[e - 1]);
      if (f1 && e - 1 > a) hangEnd = ctx.measure(e - 1, e) * f1;
    }
  }
  const L = Number(input.lineWidth(lineNo)) + hangStart + hangEnd;
  const [wMin, wDes, wMax] = sp.word, [lMin, lDes, lMax] = sp.letter, [gMin, gDes, gMax] = sp.glyph;
  const base = natural;
  // desired width: spaces at their desired %, the desired letter spacing, the desired glyph scale; the hyphen unscaled
  const desired = (base + S * sw * (wDes - 1) + G * space * lDes) * gDes + hyph;
  const stretch = (S * sw * (wMax - wDes) + G * space * (lMax - lDes)) * gDes + base * (gMax - gDes);
  const shrink = (S * sw * (wDes - wMin) + G * space * (lDes - lMin)) * gDes + base * (gDes - gMin);
  return { a, end: e, at: c.at, natural, hyph, S, G, sw, L, hangStart, hangEnd, desired, stretch: Math.max(0, stretch), shrink: Math.max(0, shrink) };
}

/** Whether a line is set justified: justified alignments, except a paragraph's last line unless justify-all. */
function lineJustified(ctx, last) {
  return ctx.justified && (!(last && ctx.lastSegment) || ctx.style.align === 'justify-all');
}

/**
 * The B.3 justify result of a line set to fill `info.L` (justified) or at its desired spacing (ragged); also the
 * single-word rule. Returns { justify?, hang? } (nothing for a line at natural spacing without hanging punctuation).
 */
export function setLine(ctx, info, justified) {
  const { sp, space } = ctx;
  const { natural: base, hyph, S, G, sw, L } = info;
  const [wMin, wDes, wMax] = sp.word, [lMin, lDes, lMax] = sp.letter, [gMin, gDes, gMax] = sp.glyph;
  let w = wDes, l = lDes, g = gDes;
  let shiftStart = 0; // single-word lines set left / centre / right inside a justified paragraph
  if (justified) {
    // fill: (base + S·sw·(w − 1) + G·space·l)·g + hyph = L
    const target = L - hyph;
    const width = () => (base + S * sw * (w - 1) + G * space * l) * g;
    if (S === 0 && sp.singleWord !== 'justify-all') {
      const slack = target - width();
      if (slack > 0 && sp.singleWord === 'center') shiftStart = slack / 2;
      else if (slack > 0 && sp.singleWord === 'right') shiftStart = slack;
    } else {
      let need = target - width();
      if (need > 0) {
        // stretch: word spacing to its maximum, then letter spacing, then glyph scaling, then word spacing beyond
        // its maximum (letter spacing when the line has no space)
        if (S) {
          const dw = Math.min(need, S * sw * (wMax - w) * g);
          w += dw / (S * sw * g);
          need -= dw;
        }
        if (need > 1e-9 && G) {
          const dl = Math.min(need, G * space * (lMax - l) * g);
          l += dl / (G * space * g);
          need -= dl;
        }
        if (need > 1e-9) {
          const inner = base + S * sw * (w - 1) + G * space * l;
          if (inner > 0) {
            const g2 = Math.min(gMax, (target) / inner);
            if (g2 > g) {
              need -= (g2 - g) * inner;
              g = g2;
            }
          }
        }
        if (need > 1e-9) {
          if (S) w += need / (S * sw * g);
          else if (G) l += need / (G * space * g);
        }
      } else if (need < 0) {
        // shrink: word spacing to its minimum, then letter spacing, then glyph scaling (beyond that the line overflows)
        let over = -need;
        if (S) {
          const dw = Math.min(over, S * sw * (w - wMin) * g);
          w -= dw / (S * sw * g);
          over -= dw;
        }
        if (over > 1e-9 && G) {
          const dl = Math.min(over, G * space * (l - lMin) * g);
          l -= dl / (G * space * g);
          over -= dl;
        }
        if (over > 1e-9) {
          const inner = base + S * sw * (w - 1) + G * space * l;
          if (inner > 0) {
            const g2 = Math.max(gMin, target / inner);
            if (g2 < g) g = g2;
          }
        }
      }
    }
  }
  let wordSpace = S ? sw * (w - 1) : 0;
  let letterSpace = space * l;
  if (!SPACES_SHRINK && wordSpace < 0 && G > 0) {
    letterSpace += (wordSpace * S) / G;
    wordSpace = 0;
  }
  const out = {};
  if (Math.abs(wordSpace) > 1e-9 || Math.abs(letterSpace) > 1e-9 || Math.abs(g - 1) > 1e-9) out.justify = { wordSpace, letterSpace, glyphScale: g };
  if (info.hangStart || info.hangEnd || shiftStart) out.hang = { start: info.hangStart - shiftStart, end: info.hangEnd + shiftStart };
  return out;
}

/** The B.3 line record of [a, c.at). */
function lineRecord(ctx, info, c, last, lineNo) {
  const rec = { from: info.a, to: last ? ctx.to : c.at, hyphen: !!c.hyphen, textFrom: info.a, textTo: info.end, line: lineNo };
  const set = setLine(ctx, info, lineJustified(ctx, last));
  if (set.justify) rec.justify = set.justify;
  if (set.hang) rec.hang = set.hang;
  return rec;
}

// ---- Adobe Single-line Composer -------------------------------------------------------------------------------------------

/**
 * Greedy, one line at a time, with Photoshop's preferences: compressed or expanded word spacing is preferable to
 * hyphenation (a justified line whose word spacing stays within Minimum..Maximum is never hyphenated); hyphenation is
 * preferable to letter spacing and glyph scaling; in ragged text a word is hyphenated only when the line would
 * otherwise end further than the hyphenation zone from the margin.
 */
export function composeSingle(input) {
  const style = input.style ?? {};
  if (isLegacyParagraph(style)) return legacyGreedy(input);
  const ctx = makeContext(input);
  const cands = candidates(ctx, { withHyphens: true, emergency: true });
  const hy = style.hyphenation ?? {};
  const limit = Number(hy.limit) || 0;
  const lines = [];
  let a = ctx.from, n = 0, hyphens = 0, k = 0;
  // a line may not start before its first candidate after `a`
  while (true) {
    const last = (c) => c.kind === 'end';
    let best = null; // the last whole-word break that fits
    let bestInfo = null;
    let j = k;
    let overflow = null;
    for (; j < cands.length; j++) {
      const c = cands[j];
      if (c.at <= a) continue;
      if (c.kind === 'auto' || c.kind === 'emergency' || (c.shy && c.hyphen)) continue; // considered below
      const info = lineInfo(ctx, a, c, n);
      // justified lines (and a justified paragraph's last line) may close up to the minimum spacing
      const fits = (lineJustified(ctx, last(c)) || ctx.justified ? info.desired - info.shrink : info.desired) <= info.L + 1e-6;
      if (fits) {
        best = c;
        bestInfo = info;
        if (last(c) || c.kind === 'mandatory') break;
      } else {
        overflow = c;
        break;
      }
    }
    let choice = best, choiceInfo = bestInfo;
    if (overflow || !best) {
      // hyphenation points (and soft hyphens) between the last fit and the break that does not fit
      const lo = best ? best.at : a;
      const hi = overflow ? overflow.at : ctx.to;
      const inner = cands.filter((c) => c.at > lo && c.at < hi && c.hyphen);
      let hyChoice = null, hyInfo = null;
      if (!limit || hyphens < limit) {
        for (const c of inner) {
          const info = lineInfo(ctx, a, c, n);
          const just = lineJustified(ctx, false);
          if ((just ? info.desired - info.shrink : info.desired) <= info.L + 1e-6) {
            hyChoice = c;
            hyInfo = info;
          }
        }
      }
      if (hyChoice) {
        let take = true;
        if (best && lineJustified(ctx, false)) {
          // spacing within Minimum..Maximum beats a hyphen
          const r = ratio(bestInfo);
          if (r >= -1 && r <= 1) take = false;
        } else if (best) {
          // ragged: hyphenate only when the line would end further than the zone from the margin
          const slack = bestInfo.L - bestInfo.desired;
          if (slack < (Number(hy.zone) || 0)) take = false;
        }
        if (take) {
          choice = hyChoice;
          choiceInfo = hyInfo;
        }
      }
      if (!choice) {
        // nothing fits: break inside an overlong word at the last point that fits, else take the overfull word
        const em = cands.filter((c) => c.at > a && c.at < hi && c.kind === 'emergency');
        for (const c of em) {
          const info = lineInfo(ctx, a, c, n);
          if (info.desired <= info.L + 1e-6 || !choice) {
            choice = c;
            choiceInfo = info;
          }
        }
        if (!choice) {
          choice = overflow ?? cands[cands.length - 1];
          choiceInfo = lineInfo(ctx, a, choice, n);
        }
      }
    }
    const isLast = choice.kind === 'end';
    lines.push(lineRecord(ctx, choiceInfo, choice, isLast, n));
    if (isLast) break;
    hyphens = choice.hyphen ? hyphens + 1 : 0;
    a = choice.at;
    n++;
    k = cands.findIndex((c) => c.at > a);
    if (k < 0) {
      lines.push(lineRecord(ctx, lineInfo(ctx, a, cands[cands.length - 1], n), cands[cands.length - 1], true, n));
      break;
    }
  }
  return lines.map(stripLine);
}

const stripLine = ({ line, ...rest }) => rest;

/** Adjustment ratio of a justified line: −1 at full shrink, 1 at the maximum stretch, beyond 1 looser. */
function ratio(info) {
  const d = info.L - info.desired;
  if (d >= 0) return info.stretch > 0 ? d / info.stretch : d > 1e-6 ? Infinity : 0;
  return info.shrink > 0 ? d / info.shrink : -Infinity;
}

// ---- Adobe Every-line Composer (Knuth and Plass) --------------------------------------------------------------------------

/**
 * Total-fit line breaking: the breaks that minimise the sum of the lines' demerits over the whole paragraph. Justified
 * lines are rated by how far their spacing moves from the desired values (TeX's badness 100·r³); ragged lines by how
 * far they fall short of the margin against a stretch of six spaces (so the rag is even); hyphens cost a penalty, two
 * hyphenated lines in a row and a hyphenated second-to-last line more; Hyphen Limit and Hyphenation Zone are hard
 * rules. Three passes as TeX: without hyphenation, with it, then an emergency pass that accepts anything.
 */
export function composeEvery(input) {
  const style = input.style ?? {};
  if (isLegacyParagraph(style)) return legacyGreedy(input);
  const ctx = makeContext(input);
  const passes = [
    { withHyphens: false, tolerance: PRETOLERANCE, emergency: false },
    { withHyphens: true, tolerance: TOLERANCE, emergency: false },
    { withHyphens: true, tolerance: Infinity, emergency: true },
  ];
  for (const pass of passes) {
    if (pass.withHyphens && !input.hyphenate && !pass.emergency) continue;
    const res = knuthPlass(ctx, pass);
    if (res) return res.map(stripLine);
  }
  return composeSingle(input);
}

function knuthPlass(ctx, { withHyphens, tolerance, emergency }) {
  const cands = candidates(ctx, { withHyphens, emergency });
  const hy = ctx.style.hyphenation ?? {};
  const limit = Number(hy.limit) || 0;
  const zone = Number(hy.zone) || 0;
  const ragStretch = (info) => 6 * info.sw;
  const start = { at: ctx.from, line: 0, fitness: 1, hyphens: 0, demerits: 0, prev: null, cand: null, info: null };
  let active = [start];
  for (const c of cands) {
    const last = c.kind === 'end';
    const forced = c.penalty === -Infinity;
    const best = new Map(); // key -> node
    const keep = [];
    let rescue = null; // the best overfull line, should nothing else reach this break
    for (const a of active) {
      if (c.at <= a.at) {
        keep.push(a);
        continue;
      }
      const info = lineInfo(ctx, a.at, c, a.line);
      const just = lineJustified(ctx, last);
      let r, bad;
      if (just) {
        r = ratio(info);
        bad = r < -1 ? Infinity : badness(r, emergency);
      } else {
        const d = info.L - info.desired;
        r = d < -1e-6 ? -Infinity : last ? 0 : d / ragStretch(info);
        bad = r === -Infinity ? Infinity : last ? 0 : badness(r, emergency);
      }
      if (last && ctx.lastSegment && (ctx.justified ? info.desired - info.shrink : info.desired) <= info.L + 1e-6) {
        // the paragraph's last line costs nothing (TeX's \parfillskip): a justified paragraph's may close up to its
        // minimum spacing, and justify-all's is stretched to the margin whatever that takes, as Photoshop does
        r = 0;
        bad = 0;
      }
      const overfull = r < -1 || r === -Infinity;
      if (!overfull && !forced) keep.push(a);
      if (overfull) {
        const over = info.desired - info.shrink - info.L;
        const d = a.demerits + 1e8 + over * over;
        if (!rescue || d < rescue.demerits) rescue = { a, info, demerits: d };
        continue;
      }
      if (bad > tolerance) continue;
      // Hyphen Limit and Hyphenation Zone
      if (c.hyphen && c.flagged && limit && a.hyphens + 1 > limit) continue;
      if (c.kind === 'auto' && !just && zone > 0 && c.wordStart !== undefined) {
        let e = c.wordStart;
        while (e > a.at && isTrailingSpace(ctx.text[e - 1])) e--;
        if (e > a.at && info.L - ctx.measure(a.at, e) < zone) continue;
      }
      let dem = (LINE_PENALTY + bad) ** 2;
      if (c.penalty > 0 && Number.isFinite(c.penalty)) dem += c.penalty ** 2;
      if (c.flagged && a.cand?.flagged) dem += DOUBLE_HYPHEN_DEMERITS;
      if (last && a.cand?.flagged) dem += FINAL_HYPHEN_DEMERITS;
      const fitness = !just ? 1 : r < -0.5 ? 0 : r <= 0.5 ? 1 : r <= 1 ? 2 : 3;
      if (just && Math.abs(fitness - a.fitness) > 1) dem += FITNESS_DEMERITS;
      const total = a.demerits + dem;
      // Hyphen Limit counts lines that end with a drawn hyphen; explicit hyphens in the text do not count
      const hyphens = c.hyphen ? a.hyphens + 1 : 0;
      const key = `${fitness}|${limit ? hyphens : c.flagged ? 1 : 0}`;
      const prev = best.get(key);
      if (!prev || total < prev.demerits) best.set(key, { at: c.at, line: a.line + 1, fitness, hyphens, demerits: total, prev: a, cand: c, info });
    }
    if (!best.size && emergency && rescue && !keep.some((k) => k.at < c.at)) {
      // nothing reaches this break without overflowing and no earlier break can go further: accept the overfull line
      const { a, info } = rescue;
      best.set('rescue', { at: c.at, line: a.line + 1, fitness: 1, hyphens: c.hyphen ? a.hyphens + 1 : 0, demerits: rescue.demerits, prev: a, cand: c, info });
    }
    active = forced ? [...best.values()] : [...keep, ...best.values()];
    if (!active.length) return null;
    if (last) break;
  }
  let end = null;
  for (const node of active) if (node.cand?.kind === 'end' && (!end || node.demerits < end.demerits)) end = node;
  if (!end) return null;
  const chain = [];
  for (let node = end; node.prev; node = node.prev) chain.push(node);
  chain.reverse();
  return chain.map((node, i) => lineRecord(ctx, node.info, node.cand, i === chain.length - 1, node.prev.line));
}

/**
 * TeX's badness 100·|r|³, capped at 10000 except in the emergency pass: there every line is allowed, and an uncapped
 * badness spreads the looseness over the lines instead of piling it on one (TeX would leave one very loose line).
 */
function badness(r, uncapped = false) {
  if (r === Infinity) return uncapped ? 1e7 : 10000;
  const b = 100 * Math.abs(r) ** 3;
  return !uncapped && b > 10000 ? 10000 : b;
}

/** The composers registered with the facade (B.2 registerComposer). */
export const singleLineComposer = Object.freeze({ id: 'single', name: 'Adobe Single-line Composer', compose: composeSingle });
export const everyLineComposer = Object.freeze({ id: 'every', name: 'Adobe Every-line Composer', compose: composeEvery });

// ---- lists (B.2 registerListFormatter) ----------------------------------------------------------------------------------

const BULLETS = ['•', '◦', '▪'];
const NUMBER_STYLES = ['decimal', 'lower-alpha', 'upper-alpha', 'lower-roman', 'upper-roman'];
export const LIST_MARKERS = Object.freeze({ bullet: ['•', '◦', '▪', '–', '✓', '★'], number: NUMBER_STYLES });

const ROMAN = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']];
export function toRoman(n) {
  if (!(n > 0)) return String(n);
  let out = '';
  for (const [v, r] of ROMAN) while (n >= v) {
    out += r;
    n -= v;
  }
  return out;
}
export function toAlpha(n) {
  if (!(n > 0)) return String(n);
  let s = '';
  for (let k = n; k > 0; k = Math.floor((k - 1) / 26)) s = String.fromCharCode(97 + ((k - 1) % 26)) + s;
  return s;
}

/** The label of number n in a numbering style ('decimal' 3 -> '3'). */
export function numberLabel(n, style) {
  if (style === 'lower-alpha') return toAlpha(n);
  if (style === 'upper-alpha') return toAlpha(n).toUpperCase();
  if (style === 'lower-roman') return toRoman(n);
  if (style === 'upper-roman') return toRoman(n).toUpperCase();
  return String(n);
}

/**
 * The number of paragraph `index` in its list: counted over the numbered paragraphs before it at the same level; a
 * paragraph that is not a numbered list item, or one at a shallower level, ends the count (a nested list restarts
 * after each item of its parent). The first item's `start` sets the first number.
 */
export function listNumber(paras, index) {
  const list = paras[index]?.style?.list;
  if (!list || list.type !== 'number') return null;
  const level = list.level ?? 0;
  let count = 0;
  let first = list;
  for (let k = index; k >= 0; k--) {
    const l = paras[k]?.style?.list;
    if (!l || l.type !== 'number') break;
    const lv = l.level ?? 0;
    if (lv < level) break;
    if (lv === level) {
      count++;
      first = l;
    }
  }
  return (Number(first.start ?? 1) || 0) + count - 1;
}

/**
 * The list formatter (B.2): the marker text of paragraph `index`, or null when it is not a list item. Bullets: the
 * paragraph's marker, else •, ◦, ▪ by level; numbers: "1." in the paragraph's style (decimal, a., A., i., I.).
 */
export function listFormatter(paras, index) {
  const list = paras[index]?.style?.list;
  if (!list || (list.type !== 'bullet' && list.type !== 'number')) return null;
  const level = Math.max(0, Number(list.level) || 0);
  if (list.type === 'bullet') {
    const m = list.marker;
    // the default bullet changes with the level (•, ◦, ▪); a chosen marker stays
    if (typeof m === 'string' && m && m !== '•' && [...m].length <= 2 && !NUMBER_STYLES.includes(m)) return m;
    return BULLETS[level % BULLETS.length];
  }
  const style = NUMBER_STYLES.includes(list.marker) ? list.marker : 'decimal';
  return `${numberLabel(listNumber(paras, index), style)}.`;
}

// ---- patches the Paragraph panel applies ----------------------------------------------------------------------------------

/** Reset Paragraph: every paragraph attribute back to its default (a key set to undefined resets it, A). */
export function resetParagraphPatch() {
  return { align: undefined, indentLeft: undefined, indentRight: undefined, indentFirst: undefined, spaceBefore: undefined, spaceAfter: undefined, hyphenate: undefined, hyphenation: undefined, justification: undefined, composer: undefined, breakRules: undefined, hangingPunctuation: undefined, list: undefined, tabStop: undefined };
}

/**
 * The patch that turns a list on (type 'bullet' | 'number') or off (null). Turning one on keeps the current list's
 * level and, for the same type, its marker; a paragraph with no left indent gets one (1.5 em of `size` per level), so
 * the marker, which the engines draw in the indent, stays inside the box. Turning it off leaves the indent.
 */
export function listPatch(type, { current = null, indentLeft = 0, size = 48 } = {}) {
  if (!type) return { list: null };
  const level = current?.level ?? 0;
  const marker = current?.type === type ? current.marker : type === 'number' ? 'decimal' : '•';
  const patch = { list: { type, marker, start: current?.type === type ? current.start ?? 1 : 1, level } };
  const indent = Math.round(size * 1.5) * (level + 1);
  // a mixed indent (a symbol) is left alone
  if (indentLeft === 0 || indentLeft === undefined || indentLeft === null) patch.indentLeft = indent;
  return patch;
}

/** A nested value with only the changed sub-keys replaced (the dialogs keep each paragraph's own values for the rest). */
export function mergeChanged(value, changes) {
  return { ...(value ?? {}), ...changes };
}
