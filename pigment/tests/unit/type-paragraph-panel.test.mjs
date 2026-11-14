// type-paragraph-panel (ARCHITECTURE.md "0.4 features", package 4): the composers, the UAX 14 breaker, hyphenation and
// list numbering, checked on numbers. Pure modules only (no DOM).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../../src/renderer/lib/type/model.js';
import * as P from '../../src/renderer/lib/type/paragraph.js';
import { lineBreaks, lineBreakClass, legacyBreaks } from '../../src/renderer/lib/type/line-breaks.js';
import * as H from '../../src/renderer/lib/type/hyphenation.js';
import { layoutContent } from '../../src/renderer/lib/type/layout.js';

// ---- helpers ---------------------------------------------------------------------------------------------------------------

/** Composer input over `text` with fixed advances: every character `ch` px, a space `sp` px. */
function input(text, style, { width = 100, first = width, ch = 10, sp = 5, hyphenate = null, breaks } = {}) {
  const w = (i) => (text[i] === ' ' ? sp : ch);
  return {
    from: 0,
    to: text.length,
    text,
    lineWidth: (n) => (n === 0 ? first : width),
    measure: (a, b) => {
      let s = 0;
      for (let i = a; i < b; i++) s += w(i);
      return s;
    },
    spaceWidth: () => sp,
    hyphenWidth: () => ch,
    breaks: breaks ?? lineBreaks(text, 'en-US', { rules: style.breakRules ?? 'standard' }),
    hyphenate,
    style: M.resolvePara(style),
  };
}
const linesOf = (text, lines) => lines.map((l) => text.slice(l.textFrom ?? l.from, l.textTo ?? l.to) + (l.hyphen ? '-' : ''));

/** The facade's hyphenate(from, to) (api.js hyphenateRange) over a hyphenator: minWord, After First, Before Last, capitalized. */
function facadeHyphenate(text, lang, hy = M.PARA_DEFAULTS.hyphenation) {
  return (from, to) => {
    const word = text.slice(from, to);
    if (word.length <= hy.minWord) return null; // Words Longer Than n letters
    if (hy.capitalized === false && /^\p{Lu}/u.test(word)) return null;
    const raw = H.hyphenateWord(word, lang) ?? [];
    return raw.filter((p) => p >= hy.after && word.length - p >= hy.before).map((p) => from + p);
  };
}

const show = (word, positions) => {
  let s = '';
  [...word].forEach((c, i) => {
    if (positions.includes(i)) s += '-';
    s += c;
  });
  return s;
};

// ---- Knuth-Plass -----------------------------------------------------------------------------------------------------------

test('Every-line Composer: the classic minimum-raggedness optimum where the greedy composer is ragged', () => {
  // line width 6 characters, a space is one: greedy sets "aaa bb" / "cc" / "ddddd", the optimum "aaa" / "bb cc" / "ddddd"
  const text = 'aaa bb cc ddddd';
  const opts = { width: 60, ch: 10, sp: 10 };
  assert.deepEqual(linesOf(text, P.composeSingle(input(text, { composer: 'single' }, opts))), ['aaa bb', 'cc', 'ddddd']);
  assert.deepEqual(linesOf(text, P.composeEvery(input(text, {}, opts))), ['aaa', 'bb cc', 'ddddd']);
});

test('Every-line Composer: justified breaks are the total-fit optimum on fixed box widths (checked by brute force)', () => {
  const text = 'The quick brown fox jumps over the lazy dog and then it runs far away into the woods tonight';
  const opts = { width: 250, ch: 10, sp: 6 };
  const inp = input(text, { align: 'justify-left', justification: { ...M.PARA_DEFAULTS.justification, word: [50, 100, 200] } }, opts);
  const got = P.composeEvery(inp).map((l) => l.to);
  // brute force over every set of breaks: lines rated as the composer documents (TeX's badness, line penalty 10,
  // fitness classes), the last line free when it fits; the minimum total must be what the composer chose
  const breaks = inp.breaks.map((b) => b.at);
  const style = inp.style;
  const [wMin, wDes, wMax] = style.justification.word.map((v) => v / 100);
  const rate = (a, b, last) => {
    let e = b;
    while (e > a && text[e - 1] === ' ') e--;
    const nat = inp.measure(a, e);
    const S = (text.slice(a, e).match(/ /g) ?? []).length;
    const L = 250;
    if (last) return nat - S * 6 * (wDes - wMin) <= L ? { d: 100, f: 1 } : null;
    const diff = L - nat;
    const r = diff >= 0 ? (S ? diff / (S * 6 * (wMax - wDes)) : Infinity) : S ? diff / (S * 6 * (wDes - wMin)) : -Infinity;
    if (r < -1) return null;
    const bad = Math.min(10000, 100 * Math.abs(r) ** 3);
    if (bad > 100) return null; // the first pass's tolerance (no hyphenation: the only pass before the emergency one)
    return { d: (10 + bad) ** 2, f: r < -0.5 ? 0 : r <= 0.5 ? 1 : r <= 1 ? 2 : 3 };
  };
  let best = null;
  const walk = (a, f, total, chosen) => {
    if (best && total >= best.total) return;
    const last = rate(a, text.length, true);
    if (last) {
      const t = total + last.d + (Math.abs(last.f - f) > 1 ? 3000 : 0);
      if (!best || t < best.total) best = { total: t, chosen: [...chosen, text.length] };
    }
    for (const b of breaks) {
      if (b <= a) continue;
      const r = rate(a, b, false);
      if (!r) continue;
      walk(b, r.f, total + r.d + (Math.abs(r.f - f) > 1 ? 3000 : 0), [...chosen, b]);
    }
  };
  walk(0, 1, 0, []);
  assert.ok(best, 'the paragraph can be set within the tolerance');
  assert.deepEqual(got, best.chosen);
  // and it is not what the greedy Single-line Composer sets
  assert.notDeepEqual(P.composeSingle({ ...inp, style: { ...inp.style, composer: 'single' } }).map((l) => l.to), got);
  // every line but the last is justified to the box: (natural + spaces × wordSpace) = 160
  for (const l of P.composeEvery(inp).slice(0, -1)) {
    const S = (text.slice(l.textFrom, l.textTo).match(/ /g) ?? []).length;
    assert.ok(Math.abs(inp.measure(l.textFrom, l.textTo) + S * (l.justify?.wordSpace ?? 0) + (l.justify?.letterSpace ?? 0) * (l.textTo - l.textFrom - 1) - 250) < 1e-6);
  }
});

test('justification: word spacing within its range first, then letter spacing, then glyph scaling; shrinking closes up the word spaces', () => {
  const ctx = { sp: { word: [0.8, 1, 1.33], letter: [0, 0, 0.1], glyph: [1, 1, 1.05], singleWord: 'justify-all' }, space: 5 };
  // 2 spaces of 5: word stretch 2 × 5 × 0.33 = 3.3; letter stretch 10 gaps × 0.5 = 5; glyph 5 % of the line
  const info = (natural, L) => ({ natural, hyph: 0, S: 2, G: 10, sw: 5, L, hangStart: 0, hangEnd: 0 });
  let r = P.setLine(ctx, info(100, 102), true);
  assert.ok(Math.abs(r.justify.wordSpace - 1) < 1e-9);
  assert.equal(r.justify.letterSpace, 0);
  r = P.setLine(ctx, info(100, 106), true);
  assert.ok(Math.abs(r.justify.wordSpace - 1.65) < 1e-9);
  assert.ok(Math.abs(r.justify.letterSpace - 0.27) < 1e-9);
  assert.equal(r.justify.glyphScale, 1);
  r = P.setLine(ctx, info(100, 112), true);
  // 3.3 + 5 = 8.3 px from spacing, the rest from the glyph scale
  const g = r.justify.glyphScale;
  assert.ok(g > 1 && g <= 1.05);
  assert.ok(Math.abs((100 + 2 * r.justify.wordSpace + 10 * r.justify.letterSpace) * g - 112) < 1e-9);
  // shrinking 1 px: the two word spaces close up (both engines take a negative word spacing: SPACES_SHRINK)
  r = P.setLine(ctx, info(100, 99), true);
  if (P.SPACES_SHRINK) {
    assert.ok(Math.abs(r.justify.wordSpace + 0.5) < 1e-9);
    assert.equal(r.justify.letterSpace, 0);
  } else {
    assert.equal(r.justify.wordSpace, 0);
    assert.ok(Math.abs(r.justify.letterSpace * 10 + 1) < 1e-9);
  }
  // a ragged line at the desired spacing needs nothing
  assert.deepEqual(P.setLine(ctx, info(100, 150), false), {});
  // a single word: full justify letter-spaces it; Align Center shifts it into the middle through `hang`
  const one = { natural: 50, hyph: 0, S: 0, G: 4, sw: 5, L: 70, hangStart: 0, hangEnd: 0 };
  r = P.setLine(ctx, one, true);
  assert.ok(Math.abs((50 + 4 * r.justify.letterSpace) * r.justify.glyphScale - 70) < 1e-9);
  r = P.setLine({ ...ctx, sp: { ...ctx.sp, singleWord: 'center' } }, one, true);
  assert.equal(r.justify, undefined);
  assert.deepEqual(r.hang, { start: -10, end: 10 });
});

test('Single-line Composer: spacing within Minimum..Maximum beats a hyphen; ragged text hyphenates only past the zone', async () => {
  await H.ensureLanguage('en-US');
  const text = 'abc hyphenation';
  // justified, 120 px: "abc" alone would need its one space stretched far beyond Maximum, so the hyphen is taken
  let inp = input(text, { align: 'justify-left', hyphenate: true, composer: 'single' }, { width: 120, hyphenate: facadeHyphenate(text, 'en-US') });
  assert.deepEqual(linesOf(text, P.composeSingle(inp)), ['abc hyphen-', 'ation']);
  // the same with room for "abc hyphenation" after a little compression: no hyphen
  inp = input(text, { align: 'justify-left', hyphenate: true, composer: 'single' }, { width: 144, hyphenate: facadeHyphenate(text, 'en-US') });
  assert.deepEqual(linesOf(text, P.composeSingle(inp)), ['abc hyphenation']);
  // ragged: "abc" leaves 90 px; a zone wider than that keeps the word whole, a narrower one hyphenates
  inp = input(text, { hyphenate: true, composer: 'single', hyphenation: { ...M.PARA_DEFAULTS.hyphenation, zone: 100 } }, { width: 120, hyphenate: facadeHyphenate(text, 'en-US') });
  assert.deepEqual(linesOf(text, P.composeSingle(inp)), ['abc', 'hyphenation']);
  inp = input(text, { hyphenate: true, composer: 'single', hyphenation: { ...M.PARA_DEFAULTS.hyphenation, zone: 20 } }, { width: 120, hyphenate: facadeHyphenate(text, 'en-US') });
  assert.deepEqual(linesOf(text, P.composeSingle(inp)), ['abc hyphen-', 'ation']);
  // a word longer than the line is hyphenated whatever the zone
  inp = input(text, { hyphenate: true, composer: 'single', hyphenation: { ...M.PARA_DEFAULTS.hyphenation, zone: 100 } }, { width: 100, hyphenate: facadeHyphenate(text, 'en-US') });
  assert.deepEqual(linesOf(text, P.composeSingle(inp)), ['abc', 'hyphen-', 'ation']);
});

test('Hyphen Limit and Hyphenate Last Word', async () => {
  await H.ensureLanguage('en-US');
  const text = 'hyphenation hyphenation hyphenation hyphenation';
  const hy = (o) => ({ ...M.PARA_DEFAULTS.hyphenation, ...o });
  const run = (o) => P.composeEvery(input(text, { hyphenate: true, hyphenation: hy(o) }, { width: 160, hyphenate: facadeHyphenate(text, 'en-US') }));
  const maxRun = (lines) => {
    let n = 0, best = 0;
    for (const l of lines) {
      n = l.hyphen ? n + 1 : 0;
      best = Math.max(best, n);
    }
    return best;
  };
  for (const limit of [1, 2]) assert.ok(maxRun(run({ limit, zone: 0 })) <= limit);
  // the last word stays whole
  const lines = run({ limit: 0, zone: 0, lastWord: false });
  assert.equal(linesOf(text, lines).at(-1).endsWith('hyphenation'), true);
  assert.equal(linesOf(text, lines).at(-2).endsWith('-'), false);
});

// ---- UAX 14 --------------------------------------------------------------------------------------------------------------

test('UAX 14: Line_Break classes of a sample set', () => {
  const cls = (s) => [...s].map((c) => lineBreakClass(c.codePointAt(0)));
  assert.deepEqual(cls('A -0%$(“)'), ['AL', 'SP', 'HY', 'NU', 'PO', 'PR', 'OP', 'QU', 'CP']);
  assert.deepEqual(cls('中。、ぁ가각ก'), ['ID', 'CL', 'CL', 'CJ', 'H2', 'H3', 'SA']);
  assert.deepEqual(cls('­​⁠  \ń'), ['BA', 'ZW', 'WJ', 'GL', 'BK', 'LF', 'CM']);
  assert.deepEqual(cls('👍🏽🇫/'), ['EB', 'EM', 'RI', 'SY']);
});

test('UAX 14: opportunities after spaces, hyphens and ideographs, none inside numbers, URLs break after slashes', () => {
  const at = (s) => lineBreaks(s, 'en-US').map((b) => [b.at, b.kind]);
  assert.deepEqual(at('well-known fox'), [[5, 'hyphen'], [11, 'space']]);
  assert.deepEqual(at('3.14 and $100, 50%'), [[5, 'space'], [9, 'space'], [15, 'space']]);
  assert.deepEqual(at('(quick) “x”'), [[8, 'space']]);
  assert.deepEqual(at('日本語。'), [[1, 'other'], [2, 'other']]);
  assert.deepEqual(at('a/b'), [[2, 'other']]);
  assert.deepEqual(at('a b'), [[2, 'mandatory']]);
  assert.deepEqual(at('co­op'), [[3, 'hyphen']]);
  assert.deepEqual(at('a b c'), [[4, 'space']]);
  // Thai has no spaces between words: the dictionary finds them
  const thai = lineBreaks('ภาษาไทยง่ายนิดเดียว', 'th').map((b) => b.at);
  assert.ok(thai.length >= 2 && thai.every((x) => x > 0 && x < 19));
});

test("'legacy' rules give 0.3's breaks, and 0.3 paragraphs keep 0.3's lines", () => {
  const text = 'a well-known  CJK 日本語 line next';
  assert.deepEqual(lineBreaks(text, 'en-US', { rules: 'legacy' }), legacyBreaks(text));
  assert.deepEqual(legacyBreaks(text).map((b) => b.at), [2, 13, 14, 18, 22, 27]);
  // a version 2 paragraph (single composer, legacy breaks): exactly 0.3's greedy lines, whatever the composer asked
  const para = M.fromLegacy({ text: 'A paragraph of  several words that wraps into lines', font: { size: 10 } }).content.paras[0].style;
  assert.equal(para.composer, 'single');
  assert.equal(para.breakRules, 'legacy');
  const style = M.resolvePara(para);
  assert.equal(P.isLegacyParagraph(style), true);
  const t = 'A paragraph of  several words that wraps into lines';
  for (const comp of [P.composeSingle, P.composeEvery]) {
    const lines = comp(input(t, style, { width: 120, ch: 7, sp: 3 }));
    assert.deepEqual(lines, P.legacyGreedy(input(t, style, { width: 120, ch: 7, sp: 3 })));
  }
  assert.deepEqual(linesOf(t, P.legacyGreedy(input(t, style, { width: 120, ch: 7, sp: 3 }))), ['A paragraph of ', 'several words that', 'wraps into lines']);
  // a hyphen and CJK never break under the legacy rules
  assert.equal(legacyBreaks('well-known 日本語').map((b) => b.at).join(), '11');
});

// ---- hyphenation -------------------------------------------------------------------------------------------------------------

test('hyphenation: TeX patterns per language, exceptions, and the Words Longer Than / After First / Before Last filters', async () => {
  for (const lang of ['en-US', 'en-GB', 'de', 'fr', 'es', 'it', 'nl', 'pt']) assert.equal(await H.ensureLanguage(lang), true, lang);
  const hy = (w, lang) => show(w, H.hyphenateWord(w, lang));
  assert.equal(hy('hyphenation', 'en-US'), 'hy-phen-ation');
  assert.equal(hy('hyphenation', 'en-GB'), 'hy-phen-a-tion');
  assert.equal(hy('associates', 'en-US'), 'as-so-ciates'); // an exception of hyph-en-us
  assert.equal(hy('table', 'en-US'), 'ta-ble');
  assert.equal(hy('Silbentrennung', 'de'), 'Sil-ben-tren-nun-g');
  assert.equal(hy('typographie', 'fr'), 'ty-po-gra-phie');
  assert.equal(hy('tipografía', 'es'), 'ti-po-gra-fía');
  assert.equal(hy('tipografia', 'it'), 'ti-po-gra-fia');
  assert.equal(hy('woordafbreking', 'nl'), 'woord-af-bre-king');
  assert.equal(hy('tipografia', 'pt'), 'ti-po-gra-fia');
  // regional tags use their language's patterns; an unknown language is not hyphenated
  assert.equal(hy('Silbentrennung', 'de-AT'), 'Sil-ben-tren-nun-g');
  assert.equal(H.patternLanguage('en-AU'), 'en-GB');
  assert.equal(H.hyphenateWord('hyphenation', 'ja'), null);
  // the facade's filters: words shorter than minWord stay whole; After First / Before Last trim the ends
  const text = 'Silbentrennung';
  const at = (o) => show(text, (facadeHyphenate(text, 'de', { ...M.PARA_DEFAULTS.hyphenation, ...o })(0, text.length) ?? []));
  assert.equal(at({}), 'Sil-ben-tren-nung');
  assert.equal(at({ after: 4 }), 'Silben-tren-nung');
  assert.equal(at({ before: 5 }), 'Sil-ben-trennung');
  assert.equal(at({ minWord: 15 }), 'Silbentrennung');
  assert.equal(at({ capitalized: false }), 'Silbentrennung');
  // Liang on a hand-made pattern set
  const dict = { trie: H.parsePatterns('1ba ab1 .x2'), exceptions: H.parseExceptions('ta-bu') };
  assert.deepEqual(H.liang('abba', dict), [2]);
  assert.deepEqual(H.liang('tabu', dict), [2]);
});

// ---- lists ---------------------------------------------------------------------------------------------------------------------

test('lists: bullets by level, numbering per level that restarts under a parent item, numbering styles', () => {
  const item = (type, level = 0, marker, start = 1) => ({ style: { list: { type, marker: marker ?? (type === 'number' ? 'decimal' : '•'), start, level } } });
  const paras = [
    item('number'), item('number'), item('number', 1, 'lower-alpha'), item('number', 1, 'lower-alpha'), item('number'),
    item('number', 1, 'lower-roman'), { style: {} }, item('number', 0, 'upper-roman', 4), item('number', 0, 'upper-roman'),
    item('bullet'), item('bullet', 1), item('bullet', 2), item('bullet', 0, '✓'),
  ];
  assert.deepEqual(paras.map((_, i) => P.listFormatter(paras, i)), ['1.', '2.', 'a.', 'b.', '3.', 'i.', null, 'IV.', 'V.', '•', '◦', '▪', '✓']);
  assert.equal(P.numberLabel(1994, 'upper-roman'), 'MCMXCIV');
  assert.equal(P.numberLabel(28, 'lower-alpha'), 'ab');
  // turning a list on indents a paragraph without an indent; off leaves the indent
  assert.deepEqual(P.listPatch('bullet', { indentLeft: 0, size: 20 }), { list: { type: 'bullet', marker: '•', start: 1, level: 0 }, indentLeft: 30 });
  assert.deepEqual(P.listPatch('number', { current: { type: 'number', marker: 'upper-alpha', start: 3, level: 1 }, indentLeft: 40, size: 20 }), { list: { type: 'number', marker: 'upper-alpha', start: 3, level: 1 } });
  assert.deepEqual(P.listPatch(null), { list: null });
});

// ---- the engine with the composers ----------------------------------------------------------------------------------------------

const fakeMeasurer = (em = 0.5) => ({
  piece(text, from, to, st) {
    const units = [];
    for (let i = from; i < to; i++) units.push({ index: i, end: i + 1, advance: st.size * em, kind: 'fallback', glyphs: [], str: text[i], size: st.size });
    return { from, to, size: st.size, face: null, units };
  },
  hyphen: (st) => st.size * em,
  marker: (st, s) => s.length * st.size * em,
});

test('a justify-all paragraph that hyphenates lays out with the Every-line Composer: every line flush with the box', async () => {
  await H.ensureLanguage('en-US');
  const text = 'Typography is the art and technique of arranging type to make written language legible, readable and appealing when displayed.';
  const content = M.applyPara(M.fromPlain(text, { size: 10 }), 0, text.length, { align: 'justify-all', hyphenate: true });
  const composers = { single: P.singleLineComposer, every: P.everyLineComposer };
  const layout = layoutContent(content, {
    x: 0, y: 0, width: 120, height: null, measurer: fakeMeasurer(),
    composerFor: (id) => composers[id] ?? composers.single,
    breaker: (t, lang, o) => lineBreaks(t, lang, o),
    hyphenate: facadeHyphenate(text, 'en-US'),
  });
  assert.ok(layout.lines.length >= 5);
  for (const l of layout.lines) assert.ok(Math.abs(l.width - 120) < 1e-6, `line "${l.text}" is ${l.width} wide`);
  assert.ok(layout.lines.some((l) => l.hyphen), 'some line ends with a hyphen');
});

test('the line search adds piece widths, but lines are set from one-piece widths: flush with tracking and kerning pairs', async () => {
  await H.ensureLanguage('en-US');
  const text = 'Typography is the art and technique of arranging type to make written language legible, readable and appealing when displayed. '.repeat(4).trim();
  // not additive: 0.5 px tracking between characters (none after the last) and a −1.5 px kerning pair "Ty" / "ty"
  let calls = 0;
  const measure = (a, b) => {
    calls++;
    if (b <= a) return 0;
    let s = 0;
    for (let i = a; i < b; i++) s += text[i] === ' ' ? 5 : 9;
    s += (b - a - 1) * 0.5;
    for (let i = a; i + 1 < b; i++) if (/[Tt]/.test(text[i]) && text[i + 1] === 'y') s -= 1.5;
    return s;
  };
  for (const align of ['justify-left', 'justify-all']) {
    const style = M.resolvePara({ align, hyphenate: true });
    const inp = { ...input(text, style, { width: 250, ch: 9, sp: 5 }), measure, spaceWidth: () => 5, hyphenWidth: () => 6, hyphenate: facadeHyphenate(text, 'en-US') };
    calls = 0;
    const lines = P.composeEvery(inp);
    assert.ok(lines.length >= 8);
    // far fewer measurements than candidate lines (≈ cut points × 4 plus one per line set)
    assert.ok(calls < 2500, `${calls} measure calls`);
    lines.forEach((l, k) => {
      const last = k === lines.length - 1;
      if (last && align !== 'justify-all') return;
      const end = l.textTo;
      const seg = text.slice(l.textFrom, end);
      const S = [...seg].filter((c) => c === ' ').length;
      const G = seg.length - 1;
      const j = l.justify ?? { wordSpace: 0, letterSpace: 0, glyphScale: 1 };
      const drawn = (measure(l.textFrom, end) + S * j.wordSpace + G * j.letterSpace) * j.glyphScale + (l.hyphen ? 6 : 0);
      assert.ok(Math.abs(drawn - 250) < 1e-6, `line ${k} "${seg}" is ${drawn} wide`);
    });
  }
});
