// 0.4 skeleton, step 5: TextLayer on the rich-text model with 0.3's flat `text` / `font` views (A, "Compatibility").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TextLayer, DEFAULT_TEXT_STYLE, applyLegacyFont } from '../../src/renderer/lib/document.js';
import * as M from '../../src/renderer/lib/type/model.js';

test('a 0.3 layer comes in through fromLegacy and reads back its font bit for bit', () => {
  const font = { family: 'Georgia', size: 7, weight: 700, italic: true, underline: true, color: '#123456', align: 'center', lineHeight: 1.5, letterSpacing: 0.5, stroke: { color: '#ff0000', width: 2 } };
  const l = new TextLayer({ text: 'Hello\nworld', font });
  assert.deepEqual(l.font, { ...DEFAULT_TEXT_STYLE, ...font });
  assert.equal(l.text, 'Hello\nworld');
  assert.equal(l.name, 'Hello');
  assert.equal(l.height, null);
  assert.deepEqual(M.resolvePara(l.content.paras[1].style).breakRules, 'legacy');
  assert.equal(M.resolvePara(l.content.paras[0].style).composer, 'single');
  // a default 0.3 font stores nothing but the legacy paragraph rules (1.2 line height is the default 120 % auto leading)
  const plain = new TextLayer({ text: 'x' });
  assert.deepEqual(M.nonDefaultKeys(plain.content), { char: [], para: ['composer', 'breakRules'] });
  assert.deepEqual(plain.font, DEFAULT_TEXT_STYLE);
  // the returned font is a copy
  const f = l.font;
  f.size = 99;
  f.stroke.width = 9;
  assert.equal(l.font.size, 7);
  assert.equal(l.font.stroke.width, 2);
});

test('orientation lives in typeOptions; a font without it is horizontal', () => {
  const l = new TextLayer({ text: 'Up', font: { orientation: 'vertical' } });
  assert.equal(l.typeOptions.orientation, 'vertical');
  assert.equal(l.font.orientation, 'vertical');
  const f = l.font;
  delete f.orientation;
  l.font = f;
  assert.equal(l.typeOptions.orientation, 'horizontal');
  assert.equal('orientation' in l.font, false);
});

test('set text keeps the formatting outside the changed span; set font flattens only the changed attribute', () => {
  let content = M.fromPlain('Hello World', { color: '#ff0000' });
  content = M.applyChar(content, 6, 11, { color: '#0000ff', size: 60 });
  const l = new TextLayer({ content });
  l.text = 'Hello WoXrld';
  assert.deepEqual(l.content.runs.map((r) => [r.len, r.style.color]), [[6, '#ff0000'], [6, '#0000ff']]);
  // underline on: applied to the whole text; the two sizes and colours stay
  l.font = { ...l.font, underline: true };
  assert.deepEqual(M.runsIn(l.content).map((r) => [r.style.color, r.style.size, r.style.underline]), [['#ff0000', 48, true], ['#0000ff', 60, true]]);
  // letter spacing is converted with the size being set
  const r = applyLegacyFont(l.content, l.typeOptions, { ...l.font, letterSpacing: 2.4, size: 24 });
  assert.deepEqual(M.runsIn(r.content).map((x) => [x.style.size, x.style.tracking]), [[24, 100], [24, 100]]);
  // line height becomes auto leading of every paragraph
  const lh = applyLegacyFont(l.content, l.typeOptions, { ...l.font, lineHeight: 1.75 });
  assert.equal(M.resolvePara(lh.content.paras[0].style).justification.autoLeading, 175);
  assert.equal(new TextLayer({ content: lh.content }).font.lineHeight, 1.75);
});

test('an empty text keeps its insertion style through set font', () => {
  const l = new TextLayer({ text: '', font: { size: 30 } });
  l.font = { ...l.font, color: '#00ff00' };
  assert.equal(l.font.color, '#00ff00');
  assert.equal(l.font.size, 30);
  l.text = 'typed';
  assert.equal(M.charStyleAt(l.content, 0).color, '#00ff00');
});
