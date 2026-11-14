// type-editing (ARCHITECTURE.md "0.4 features", package 2): the pure selection rules of the Type tool editor. No DOM:
// the unit tests (tests/unit/type-editing.test.mjs) import this file in Node.
//
// Indices are UTF-16 code units of the content's plain text (A). The caret never stops inside a grapheme cluster
// (an emoji ZWJ sequence, a letter with combining marks): every move goes from one cluster boundary to the next,
// found with Intl.Segmenter. Words follow Intl.Segmenter's word segmentation of the text's language, which is
// what a double-click selects.

const segmenters = new Map();
function segmenter(granularity, locale) {
  const key = `${granularity}|${locale ?? ''}`;
  let s = segmenters.get(key);
  if (!s) {
    s = new Intl.Segmenter(locale || undefined, { granularity });
    segmenters.set(key, s);
  }
  return s;
}

// one cache entry per granularity: the boundaries of the last text asked for (the editor asks about the same text
// many times between two edits)
const boundaryCache = new Map();
function boundaries(text, granularity, locale) {
  const key = `${granularity}|${locale ?? ''}`;
  const hit = boundaryCache.get(key);
  if (hit && hit.text === text) return hit.list;
  const list = [];
  for (const seg of segmenter(granularity, locale).segment(text)) list.push({ from: seg.index, to: seg.index + seg.segment.length, word: granularity === 'word' ? !!seg.isWordLike : true });
  boundaryCache.set(key, { text, list });
  return list;
}

const clampIndex = (text, i) => Math.max(0, Math.min(text.length, Math.round(Number(i) || 0)));

/** Grapheme cluster starts of text, and text.length (every place the caret may stand). */
export function graphemeStops(text) {
  const stops = boundaries(text, 'grapheme').map((s) => s.from);
  stops.push(text.length);
  return stops;
}

/** The nearest cluster boundary at or before i (a caret inside a cluster moves to its start). */
export function snapToCluster(text, i) {
  const at = clampIndex(text, i);
  if (at === 0 || at === text.length) return at;
  let best = 0;
  for (const s of boundaries(text, 'grapheme')) {
    if (s.from > at) break;
    best = s.from;
  }
  return best;
}

/** The next caret stop after i (one grapheme cluster to the right in logical order). */
export function nextCluster(text, i) {
  const at = clampIndex(text, i);
  for (const s of boundaries(text, 'grapheme')) if (s.from <= at && s.to > at) return s.to;
  return text.length;
}

/** The previous caret stop before i. */
export function prevCluster(text, i) {
  const at = clampIndex(text, i);
  let prev = 0;
  for (const s of boundaries(text, 'grapheme')) {
    if (s.from >= at) break;
    prev = s.from;
  }
  return prev;
}

/**
 * The word a double-click at index i selects: the word segment that contains i (at the end of a word, the word
 * before), or the run of spaces or punctuation there. Never crosses a paragraph end or a forced line break.
 */
export function wordRange(text, i, locale) {
  const at = clampIndex(text, i);
  if (!text) return [0, 0];
  const segs = boundaries(text, 'word', locale);
  let seg = segs.find((s) => s.from <= at && at < s.to) ?? null;
  // at the end of a word (or of the text), the word before the caret
  const before = segs.find((s) => s.to === at) ?? null;
  if (before && before.word && (!seg || !seg.word)) seg = before;
  if (!seg) seg = before ?? segs[segs.length - 1];
  if (isBreak(text, seg.from)) {
    // a click on a line end: the empty range there
    return [seg.from, seg.from];
  }
  if (seg.word) return [seg.from, seg.to];
  // spaces or punctuation: the whole run of the same kind, stopping at line ends
  let a = seg.from, b = seg.to;
  while (b < text.length && !isBreak(text, b) && !isWordAt(segs, b) && sameKind(text[b], text[seg.from])) b = nextSeg(segs, b);
  while (a > 0 && !isBreak(text, a - 1) && !isWordAt(segs, a - 1) && sameKind(text[a - 1], text[seg.from])) a = prevSegStart(segs, a);
  return [a, b];
}

const isBreak = (text, i) => text[i] === '\n' || text[i] === '\u2028';
const isSpace = (ch) => ch === ' ' || ch === '\t' || ch === '\u3000' || ch === '\u00a0';
const sameKind = (a, b) => isSpace(a) === isSpace(b);
const isWordAt = (segs, i) => !!segs.find((s) => s.from <= i && i < s.to)?.word;
const nextSeg = (segs, i) => segs.find((s) => s.from <= i && i < s.to)?.to ?? i + 1;
const prevSegStart = (segs, i) => segs.find((s) => s.from < i && i <= s.to)?.from ?? i - 1;

/**
 * Ctrl/Alt + Right: the start of the next word (Windows and Photoshop on Windows; macOS's Option+Right stops at the
 * word's end, `{ toEnd: true }`). A paragraph end is a stop of its own.
 */
export function nextWord(text, i, { toEnd = false, locale } = {}) {
  let at = clampIndex(text, i);
  if (at >= text.length) return text.length;
  const segs = boundaries(text, 'word', locale);
  const segAt = (k) => segs.find((s) => s.from <= k && k < s.to);
  if (isBreak(text, at)) return at + 1;
  if (toEnd) {
    // skip what is not a word, then to the end of the word
    while (at < text.length && !segAt(at)?.word && !isBreak(text, at)) at = segAt(at)?.to ?? at + 1;
    if (at < text.length && segAt(at)?.word) at = segAt(at).to;
    return at;
  }
  // to the end of the current word (or punctuation), then over the spaces after it
  const cur = segAt(at);
  if (cur && !isSpace(text[at])) at = cur.to;
  while (at < text.length && isSpace(text[at])) at++;
  return at;
}

/** Ctrl/Alt + Left: the start of the word before i (over spaces first). */
export function prevWord(text, i, { locale } = {}) {
  let at = clampIndex(text, i);
  if (at <= 0) return 0;
  const segs = boundaries(text, 'word', locale);
  if (isBreak(text, at - 1)) return at - 1;
  while (at > 0 && isSpace(text[at - 1])) at--;
  if (at === 0 || isBreak(text, at - 1)) return at;
  const seg = segs.find((s) => s.from < at && at <= s.to);
  return seg ? seg.from : at - 1;
}

/** The paragraph around index i: [start, end) without its '\n'. */
export function paragraphRange(text, i) {
  const at = clampIndex(text, i);
  const a = text.lastIndexOf('\n', at - 1) + 1;
  const nl = text.indexOf('\n', at);
  return [a, nl === -1 ? text.length : nl];
}

/**
 * The laid-out line around index i: [from, to) of the layout line (B.3 LayoutLine: `to` includes the spaces that end
 * the line and excludes a '\n'). affinity 'trailing' at a soft line end means the line that ends there.
 */
export function lineRange(lines, i, affinity = 'leading') {
  const line = lineAt(lines, i, affinity);
  return line ? [line.from, line.to] : [i, i];
}

/** The layout line that holds a caret at i (with its affinity at a soft wrap). */
export function lineAt(lines, i, affinity = 'leading') {
  if (!lines?.length) return null;
  if (affinity === 'trailing') {
    const ending = lines.find((l, k) => l.to === i && k < lines.length - 1 && lines[k + 1].from === i);
    if (ending) return ending;
  }
  for (let k = 0; k < lines.length; k++) {
    const l = lines[k], next = lines[k + 1];
    if (i >= l.from && (i < l.to || (i === l.to && (!next || next.from > i)))) return l;
  }
  return i <= lines[0].from ? lines[0] : lines[lines.length - 1];
}

/**
 * What a click of `count` clicks selects around index i (Photoshop): 1 the caret, 2 a word, 3 a line, 4 a
 * paragraph, 5 the whole text.
 */
export function unitRange(count, text, i, { lines = null, affinity = 'leading', locale } = {}) {
  const at = clampIndex(text, i);
  switch (Math.max(1, Math.min(5, count))) {
    case 1: return [at, at];
    case 2: return wordRange(text, at, locale);
    case 3: {
      if (!lines?.length) return paragraphRange(text, at);
      const [a, b] = lineRange(lines, at, affinity);
      return [a, b];
    }
    case 4: return paragraphRange(text, at);
    default: return [0, text.length];
  }
}

/**
 * Selection while dragging after a multi-click: the union of the unit the drag started in and the unit under the
 * pointer, with the anchor on the far side of the start unit (so a word drag extends by whole words).
 */
export function extendByUnit(startUnit, hereUnit) {
  const [a0, b0] = startUnit, [a1, b1] = hereUnit;
  if (a1 < a0) return { anchor: b0, focus: a1 };
  if (b1 > b0) return { anchor: a0, focus: b1 };
  return { anchor: a0, focus: b0 };
}

/**
 * Click counting for multi-clicks: a click within `interval` ms and `slop` screen px of the previous one counts on;
 * after five clicks the count starts again at one.
 */
export function nextClickCount(prev, { t, x, y }, { interval = 500, slop = 5 } = {}) {
  if (prev && t - prev.t <= interval && Math.abs(x - prev.x) <= slop && Math.abs(y - prev.y) <= slop) return prev.count >= 5 ? 1 : prev.count + 1;
  return 1;
}

/** The ordered pair of a selection { anchor, focus }. */
export function ordered(sel) {
  return sel.anchor <= sel.focus ? [sel.anchor, sel.focus] : [sel.focus, sel.anchor];
}
