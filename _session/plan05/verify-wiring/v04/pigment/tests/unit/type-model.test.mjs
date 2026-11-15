// Rich-text model (0.4 skeleton, A): every operation, MIXED, ranges, the 0.3 compatibility.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHAR_DEFAULTS, PARA_DEFAULTS, TYPE_OPTION_DEFAULTS, CHAR_KEYS, PARA_KEYS, RANGES, MIXED,
  resolveChar, resolvePara, fromPlain, fromLegacy, legacyFont, plainText, contentLength,
  insertText, deleteRange, replaceRange, replacePlain, sliceContent, insertContent, applyChar, applyPara,
  charAttrs, paraAttrs, charStyleAt, paraIndexAt, paragraphs, runsIn, splitAt, normalize, mapChar, mapPara,
  scaleContent, isUniform, nonDefaultKeys, equalStyle, cloneContent, validate,
} from '../../src/renderer/lib/type/model.js';

const RED = { color: '#ff0000' };
const BIG = { size: 72 };

/** "Hello world" with "world" red. */
const twoRuns = () => applyChar(fromPlain('Hello world'), 6, 11, RED);
const runSummary = (c) => c.runs.map((r) => [r.len, r.style]);

test('defaults, keys and ranges are frozen and complete', () => {
  assert.ok(Object.isFrozen(CHAR_DEFAULTS) && Object.isFrozen(PARA_DEFAULTS.justification.word));
  assert.equal(CHAR_DEFAULTS.size, 48);
  assert.equal(CHAR_DEFAULTS.leading, 'auto');
  assert.equal(PARA_DEFAULTS.composer, 'every');
  assert.equal(PARA_DEFAULTS.justification.autoLeading, 120);
  assert.deepEqual(TYPE_OPTION_DEFAULTS, { orientation: 'horizontal', antiAlias: 'smooth', systemLayout: false });
  assert.equal(CHAR_KEYS.length, 24);
  assert.equal(PARA_KEYS.length, 14);
  assert.deepEqual(RANGES.size, [0.1, 10000]);
  assert.equal(typeof MIXED, 'symbol');
  assert.equal(resolveChar({ size: 10 }).size, 10);
  assert.equal(resolveChar({}).fontFamily, 'Arial');
  assert.equal(resolvePara({ align: 'center' }).align, 'center');
  // resolved values are copies: mutating them leaves the defaults alone
  resolvePara({}).justification.word[0] = 1;
  assert.equal(PARA_DEFAULTS.justification.word[0], 80);
});

test('fromPlain: one run, one paragraph style per paragraph, empty text keeps a zero-length run', () => {
  const c = fromPlain('ab\ncd', BIG, { align: 'right' });
  assert.equal(c.v, 1);
  assert.deepEqual(runSummary(c), [[5, BIG]]);
  assert.equal(c.paras.length, 2);
  assert.deepEqual(c.paras.map((p) => p.style), [{ align: 'right' }, { align: 'right' }]);
  const e = fromPlain('', RED);
  assert.deepEqual(runSummary(e), [[0, RED]]);
  assert.equal(e.paras.length, 1);
  assert.deepEqual(validate(c), []);
  assert.deepEqual(validate(e), []);
  assert.equal(plainText(c), 'ab\ncd');
  assert.equal(contentLength(c), 5);
  assert.ok(Object.isFrozen(c) && Object.isFrozen(c.runs[0].style));
});

test('insertText takes the style before the caret (the first character at 0); newlines split paragraphs', () => {
  const c = twoRuns();
  assert.deepEqual(runSummary(insertText(c, 8, 'X')), [[6, {}], [6, RED]]);
  assert.deepEqual(runSummary(insertText(c, 6, 'X')), [[7, {}], [5, RED]]);
  assert.deepEqual(runSummary(insertText(c, 0, 'X')), [[7, {}], [5, RED]]);
  assert.deepEqual(runSummary(insertText(c, 0, 'X', BIG)), [[1, BIG], [6, {}], [5, RED]]);
  const p = applyPara(fromPlain('ab'), 0, 0, { align: 'center' });
  const split = insertText(p, 1, '\n');
  assert.equal(split.text, 'a\nb');
  assert.deepEqual(split.paras.map((x) => x.style), [{ align: 'center' }, { align: 'center' }]);
  // inserting into an empty text uses its insertion style
  assert.deepEqual(runSummary(insertText(fromPlain('', RED), 0, 'hi')), [[2, RED]]);
});

test('deleteRange joins paragraphs (the first one\'s style wins) and keeps runs', () => {
  let c = fromPlain('ab\ncd');
  c = applyPara(c, 0, 0, { align: 'center' });
  c = applyPara(c, 4, 4, { align: 'right' });
  const j = deleteRange(c, 1, 4);
  assert.equal(j.text, 'ad');
  assert.deepEqual(j.paras.map((p) => p.style), [{ align: 'center' }]);
  assert.deepEqual(runSummary(deleteRange(twoRuns(), 4, 8)), [[4, {}], [3, RED]]);
  const all = deleteRange(twoRuns(), 0, 11);
  assert.equal(all.text, '');
  assert.deepEqual(runSummary(all), [[0, {}]]);
  // reversed bounds are accepted
  assert.equal(deleteRange(twoRuns(), 8, 4).text, 'Hellrld');
});

test('replaceRange and replacePlain keep formatting outside the changed span', () => {
  const r = replaceRange(twoRuns(), 6, 11, 'there');
  assert.deepEqual(runSummary(r), [[6, {}], [5, RED]]);
  const r2 = replaceRange(twoRuns(), 0, 5, 'Bye', BIG);
  assert.deepEqual(runSummary(r2), [[3, BIG], [1, {}], [5, RED]]);
  // the 0.3 textarea assigns the whole text: one character inserted inside run 2 keeps both runs
  const p = replacePlain(twoRuns(), 'Hello worXld');
  assert.equal(p.text, 'Hello worXld');
  assert.deepEqual(runSummary(p), [[6, {}], [6, RED]]);
  const del = replacePlain(twoRuns(), 'Hello wd');
  assert.deepEqual(runSummary(del), [[6, {}], [2, RED]]);
  const same = twoRuns();
  assert.equal(replacePlain(same, 'Hello world'), same);
  const pre = replacePlain(twoRuns(), 'Oh Hello world');
  assert.deepEqual(runSummary(pre), [[9, {}], [5, RED]]);
});

test('surrogate pairs: boundaries snap to the pair start', () => {
  const c = fromPlain('a😀b');
  assert.equal(c.text.length, 4);
  const styled = applyChar(c, 2, 4, RED); // 2 is inside the pair: snaps to 1
  assert.deepEqual(runSummary(styled), [[1, {}], [3, RED]]);
  assert.equal(insertText(c, 2, 'X').text, 'aX😀b');
  assert.equal(deleteRange(c, 2, 3).text, 'a😀b'.slice(0, 1) + 'b');
  assert.equal(replacePlain(fromPlain('😀😁'), '😀😂').text, '😀😂');
  assert.deepEqual(validate(replacePlain(applyChar(fromPlain('😀😁'), 2, 4, RED), '😀😂')), []);
  const broken = normalize({ v: 1, text: 'a😀', runs: [{ len: 2, style: RED }, { len: 1, style: BIG }], paras: [{ style: {} }] });
  assert.deepEqual(validate(broken), []);
  // the low half took the high half's style
  assert.deepEqual(runSummary(broken), [[3, RED]]);
});

test('sliceContent and insertContent: formatted copy and paste', () => {
  let c = fromPlain('one\ntwo\nthree');
  c = applyPara(c, 4, 4, { align: 'center' });
  c = applyChar(c, 4, 7, BIG);
  const piece = sliceContent(c, 2, 9); // "e\ntwo\nt"
  assert.equal(piece.text, 'e\ntwo\nt');
  assert.deepEqual(piece.paras.map((p) => p.style), [{}, { align: 'center' }, {}]);
  assert.deepEqual(runSummary(piece), [[2, {}], [3, BIG], [2, {}]]);
  const target = applyPara(fromPlain('AB'), 0, 0, { align: 'right' });
  const pasted = insertContent(target, 1, piece);
  assert.equal(pasted.text, 'Ae\ntwo\ntB');
  // the complete middle paragraph keeps its style, the partial ones join the target's
  assert.deepEqual(pasted.paras.map((p) => p.style), [{ align: 'right' }, { align: 'center' }, { align: 'right' }]);
  assert.deepEqual(runSummary(pasted), [[3, {}], [3, BIG], [3, {}]]);
  // pasted at a paragraph start, the first piece paragraph is complete too
  const atStart = insertContent(target, 0, sliceContent(c, 4, 8));
  assert.equal(atStart.text, 'two\nAB');
  assert.deepEqual(atStart.paras.map((p) => p.style), [{ align: 'center' }, { align: 'right' }]);
  const empty = sliceContent(twoRuns(), 7, 7);
  assert.equal(empty.text, '');
  assert.deepEqual(runSummary(empty), [[0, RED]]);
});

test('applyChar: caret changes nothing, patches replace nested values whole, undefined resets', () => {
  const c = twoRuns();
  assert.equal(applyChar(c, 3, 3, BIG), c);
  const f = applyChar(fromPlain('ab'), 0, 2, { features: { liga: 0 } });
  const g = applyChar(f, 0, 1, { features: { kern: 0 } });
  assert.deepEqual(g.runs.map((r) => r.style.features), [{ kern: 0 }, { liga: 0 }]);
  const reset = applyChar(c, 0, 11, { color: undefined });
  assert.deepEqual(runSummary(reset), [[11, {}]]);
  // setting the default value strips the key
  assert.deepEqual(runSummary(applyChar(c, 0, 11, { color: '#000000' })), [[11, {}]]);
});

test('applyPara touches the paragraphs of the range (a caret its own); nested patch replaces whole', () => {
  const c = fromPlain('aa\nbb\ncc');
  const one = applyPara(c, 1, 1, { align: 'center' });
  assert.deepEqual(one.paras.map((p) => p.style.align), ['center', undefined, undefined]);
  const two = applyPara(c, 1, 4, { align: 'right' });
  assert.deepEqual(two.paras.map((p) => p.style.align), ['right', 'right', undefined]);
  // a range ending right after a '\n' does not touch the next paragraph
  const exact = applyPara(c, 0, 3, { align: 'right' });
  assert.deepEqual(exact.paras.map((p) => p.style.align), ['right', undefined, undefined]);
  const cur = resolvePara({});
  const j = applyPara(c, 0, 0, { justification: { ...cur.justification, autoLeading: 150 } });
  assert.deepEqual(j.paras[0].style, { justification: { ...PARA_DEFAULTS.justification, autoLeading: 150 } });
});

test('charAttrs and paraAttrs report MIXED, flat and deep', () => {
  const c = twoRuns();
  const all = charAttrs(c, 0, 11);
  assert.equal(all.color, MIXED);
  assert.equal(all.size, 48);
  assert.equal(charAttrs(c, 6, 11).color, '#ff0000');
  // a caret reads the insertion style (the character before it)
  assert.equal(charAttrs(c, 7, 7).color, '#ff0000');
  assert.equal(charAttrs(c, 6, 6).color, '#000000');
  assert.equal(charAttrs(c, 0, 0).color, '#000000');
  let p = fromPlain('a\nb');
  const cur = resolvePara({});
  p = applyPara(p, 0, 0, { justification: { ...cur.justification, word: [80, 90, 133] } });
  const flat = paraAttrs(p, 0, 3);
  assert.equal(flat.justification, MIXED);
  assert.equal(flat.align, 'left');
  const deep = paraAttrs(p, 0, 3, { deep: true });
  assert.deepEqual(deep.justification.word, [80, MIXED, 133]);
  assert.equal(deep.justification.autoLeading, 120);
  const s = applyChar(applyChar(fromPlain('ab'), 0, 1, { stroke: { color: '#ff0000', width: 2 } }), 1, 2, { stroke: { color: '#ff0000', width: 3 } });
  assert.deepEqual(charAttrs(s, 0, 2, { deep: true }).stroke, { color: '#ff0000', width: MIXED });
  assert.equal(charAttrs(s, 0, 2).stroke, MIXED);
});

test('charStyleAt, paraIndexAt, paragraphs, runsIn, splitAt', () => {
  const c = applyChar(fromPlain('ab\ncd'), 3, 5, RED);
  assert.equal(charStyleAt(c, 0).color, '#000000');
  assert.equal(charStyleAt(c, 4).color, '#ff0000');
  assert.equal(charStyleAt(c, 99).color, '#ff0000');
  assert.equal(paraIndexAt(c, 2), 0); // the '\n' belongs to the paragraph it ends
  assert.equal(paraIndexAt(c, 3), 1);
  const ps = paragraphs(c);
  assert.deepEqual(ps.map(({ index, from, to, text }) => [index, from, to, text]), [[0, 0, 2, 'ab'], [1, 3, 5, 'cd']]);
  assert.equal(ps[1].style.align, 'left');
  assert.deepEqual(runsIn(c, 1, 4).map(({ from, to, style }) => [from, to, style.color]), [[1, 3, '#000000'], [3, 4, '#ff0000']]);
  const sp = splitAt(fromPlain('abcd'), 2);
  assert.deepEqual(sp.runs.map((r) => r.len), [2, 2]);
  assert.deepEqual(normalize(sp).runs.map((r) => r.len), [4]);
});

test('normalize clamps to RANGES without rounding, strips defaults, fixes counts, and is idempotent', () => {
  const messy = {
    v: 1, text: 'abc\nd',
    runs: [
      { len: 1, style: { size: 7.25, tracking: 71.42857142857143, color: '#000000' } },
      { len: 0, style: RED },
      { len: 1, style: { size: 7.25, tracking: 71.42857142857143 } },
      { len: 1, style: { size: 99999, leading: 0.01, kern: -5000, scaleX: 0, baselineShift: 2e5, stroke: { color: '#00ff00', width: 5000 }, bogus: 1 } },
    ],
    paras: [{ style: { align: 'nope', indentFirst: -20000, tabStop: 0.5, justification: { word: [200, 50, 100] } } }],
  };
  const n = normalize(messy);
  assert.deepEqual(validate(n), []);
  assert.equal(n.runs[0].len, 2);
  assert.deepEqual(n.runs[0].style, { size: 7.25, tracking: 71.42857142857143 });
  assert.equal(n.runs[0].style.size, 7.25);
  assert.equal(n.runs[0].style.tracking, 71.42857142857143);
  assert.ok(!('color' in n.runs[0].style));
  const big = n.runs[1].style;
  assert.equal(big.size, 10000);
  assert.equal(big.leading, 0.1);
  assert.equal(big.kern, -1000);
  assert.equal(big.baselineShift, 10000);
  assert.equal(big.scaleX, 1);
  assert.deepEqual(big.stroke, { color: '#00ff00', width: 1000 });
  assert.equal(big.bogus, 1); // unknown keys are kept for newer releases
  // uncovered text takes the last run's style
  assert.equal(n.runs.reduce((s, r) => s + r.len, 0), 5);
  assert.equal(n.paras.length, 2);
  assert.equal(n.paras[0].style.align, undefined);
  assert.equal(n.paras[0].style.indentFirst, -10000);
  assert.equal(n.paras[0].style.tabStop, 1);
  assert.deepEqual(n.paras[0].style.justification.word, [50, 100, 200]);
  assert.deepEqual(normalize(n), n);
  assert.deepEqual(normalize(JSON.parse(JSON.stringify(n))), n);
  // 0.5 px spacing at size 7 survives (no rounding)
  const t = applyChar(fromPlain('x'), 0, 1, { size: 7, tracking: (0.5 * 1000) / 7 });
  assert.equal(normalize(t).runs[0].style.tracking, (0.5 * 1000) / 7);
});

test('fromLegacy / legacyFont round trip every 0.3 font field bit for bit', () => {
  const base = { family: 'Arial', size: 48, weight: 400, italic: false, underline: false, color: '#000000', align: 'left', lineHeight: 1.2, letterSpacing: 0, stroke: null };
  const fonts = [
    base,
    { ...base, size: 7, letterSpacing: 0.5, lineHeight: 1.5 },
    { ...base, family: 'Georgia', size: 13.5, weight: 700, italic: true, underline: true, color: '#12abef', align: 'center', lineHeight: 0.9, letterSpacing: -1.3, stroke: { color: '#ff0000', width: 2.5 } },
    { ...base, align: 'right', orientation: 'vertical' },
    { ...base, orientation: 'vertical-stacked', size: 9, letterSpacing: 2.2 },
  ];
  for (const font of fonts) {
    const { content, typeOptions } = fromLegacy({ text: 'Hi\nthere', font });
    assert.deepEqual(validate(content), []);
    assert.equal(content.text, 'Hi\nthere');
    assert.equal(content.runs.length, 1);
    assert.ok(content.paras.every((p) => p.style.composer === 'single' && p.style.breakRules === 'legacy'));
    assert.deepEqual(legacyFont(content, typeOptions), font, JSON.stringify(font));
  }
  // tracking is unrounded: 0.5 px at size 7
  const t = fromLegacy({ text: 'x', font: { ...base, size: 7, letterSpacing: 0.5 } });
  assert.equal(t.content.runs[0].style.tracking, (0.5 * 1000) / 7);
  assert.equal(t.typeOptions.orientation, 'horizontal');
  // defaults are left out of the content
  const d = fromLegacy({ text: 'x', font: base });
  assert.deepEqual(d.content.runs[0].style, {});
  assert.deepEqual(d.content.paras[0].style, { composer: 'single', breakRules: 'legacy' });
  // every typed letterSpacing comes back exactly at every size
  for (const size of [1, 3.5, 7, 9, 11, 12, 13.3, 48, 72, 200]) {
    for (let k = -50; k <= 200; k++) {
      const letterSpacing = k / 10;
      const tr = (letterSpacing * 1000) / size;
      if (tr < RANGES.tracking[0] || tr > RANGES.tracking[1]) continue; // tracking is clamped
      const { content } = fromLegacy({ text: 'x', font: { ...base, size, letterSpacing } });
      assert.equal(legacyFont(content).letterSpacing, letterSpacing, `size ${size} spacing ${letterSpacing}`);
    }
  }
});

test('legacyFont reads the first character and reports justify variants by their last line', () => {
  let c = applyChar(fromPlain('ab'), 1, 2, BIG);
  c = applyPara(c, 0, 0, { align: 'justify-center', justification: { ...PARA_DEFAULTS.justification, autoLeading: 150 } });
  const f = legacyFont(c, { orientation: 'horizontal' });
  assert.equal(f.size, 48);
  assert.equal(f.align, 'center');
  assert.equal(f.lineHeight, 1.5);
  assert.ok(!('orientation' in f));
  const px = applyChar(fromPlain('a'), 0, 1, { size: 20, leading: 30 });
  assert.equal(legacyFont(px).lineHeight, 1.5);
  assert.equal(legacyFont(applyPara(fromPlain('a'), 0, 0, { align: 'justify-all' })).align, 'left');
});

test('mapChar, mapPara and scaleContent', () => {
  const c = mapChar(twoRuns(), (s, r) => (r.fontFamily === 'Arial' ? { ...s, fontFamily: 'Helvetica' } : s));
  assert.ok(c.runs.every((r) => r.style.fontFamily === 'Helvetica'));
  const m = mapPara(fromPlain('a\nb'), (s) => ({ ...s, align: 'center' }));
  assert.ok(m.paras.every((p) => p.style.align === 'center'));
  let s = applyChar(fromPlain('ab'), 0, 1, { size: 10, leading: 12, baselineShift: 3, stroke: { color: '#ff0000', width: 2 }, tracking: 50 });
  s = applyPara(s, 0, 0, { indentLeft: 10, spaceAfter: 4 });
  const k = scaleContent(s, 2);
  assert.deepEqual(k.runs[0].style, { size: 20, leading: 24, baselineShift: 6, stroke: { color: '#ff0000', width: 4 }, tracking: 50 });
  assert.equal(k.runs[1].style.size, 96);
  assert.equal(k.paras[0].style.indentLeft, 20);
  assert.equal(k.paras[0].style.spaceAfter, 8);
  assert.equal(k.paras[0].style.tabStop, 72);
  assert.equal(k.paras[0].style.hyphenation.zone, 72);
  assert.deepEqual(scaleContent(s, 1), s);
});

test('isUniform, nonDefaultKeys, equalStyle, cloneContent, validate', () => {
  assert.ok(isUniform(fromPlain('a\nb', BIG)));
  assert.ok(!isUniform(twoRuns()));
  assert.ok(!isUniform(applyPara(fromPlain('a\nb'), 0, 0, { align: 'center' })));
  const k = nonDefaultKeys(applyPara(twoRuns(), 0, 0, { align: 'center' }));
  assert.deepEqual(k, { char: ['color'], para: ['align'] });
  assert.ok(equalStyle({ size: 48, color: '#ff0000' }, { color: '#ff0000' }));
  assert.ok(equalStyle({ features: { liga: 0 } }, { features: { liga: 0 } }));
  assert.ok(!equalStyle({ features: { liga: 0 } }, { features: {} }));
  assert.ok(equalStyle({ align: 'left' }, {}));
  const c = twoRuns();
  const cl = cloneContent(c);
  assert.deepEqual(cl, c);
  assert.notEqual(cl.runs, c.runs);
  assert.deepEqual(validate({ v: 1, text: 'ab', runs: [{ len: 1, style: {} }], paras: [] }).length > 0, true);
  assert.ok(validate({ v: 1, text: 'a', runs: [{ len: 1, style: { size: -3 } }], paras: [{ style: {} }] }).some((p) => /size/.test(p)));
  assert.ok(validate(null).length);
});
