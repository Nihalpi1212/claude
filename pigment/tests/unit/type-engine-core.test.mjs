// type-engine-core (ARCHITECTURE.md "0.4 features", package 1): the engine's line layout from given advances, and the
// shaping of the OFL test font (tests/fixtures/fonts/Carlito-Regular.ttf) with the real HarfBuzz (harfbuzzjs runs in
// Node as in the renderer).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as hb from 'harfbuzzjs';
import * as M from '../../src/renderer/lib/type/model.js';
import { layoutContent } from '../../src/renderer/lib/type/layout.js';
import { setHarfBuzz, shapePiece, directionRuns, caseSegments, featureList } from '../../src/renderer/lib/type/shaper.js';
import { addFaces, faceFor, harfBuzzFontProvider, synthesis } from '../../src/renderer/lib/type/fonts.js';

// ---- line layout from given advances ---------------------------------------------------------------------------------

/** A measurer whose every character advances `em` x the drawn size (fallback units, no face). */
const fakeMeasurer = (em = 0.5) => ({
  piece(text, from, to, st) {
    const units = [];
    const size = st.position === 'super' || st.position === 'sub' ? st.size * 0.583 : st.size;
    for (let i = from; i < to; i++) units.push({ index: i, end: i + 1, advance: size * em * (st.scaleX / 100), kind: 'fallback', glyphs: [], str: text[i], size });
    return { from, to, size, face: null, units };
  },
  hyphen: (st) => st.size * em,
  marker: (st, s) => s.length * st.size * em,
});
/** Greedy first fit at the breaker's opportunities (the stub composer's behaviour, without its 0.3 extras). */
const greedy = {
  id: 'single',
  compose({ from, to, lineWidth, measure, breaks }) {
    const lines = [];
    let start = from, fit = null, n = 0;
    for (const at of [...breaks.map((b) => b.at), to]) {
      if (fit === null || measure(start, at) <= lineWidth(n)) {
        fit = at;
        continue;
      }
      lines.push({ from: start, to: fit, hyphen: false });
      start = fit;
      fit = at;
      n++;
    }
    lines.push({ from: start, to, hyphen: false });
    return lines;
  },
};
const spaceBreaker = (text) => [...text].flatMap((ch, i) => (ch === ' ' ? [{ at: i + 1, kind: 'space' }] : []));
const lay = (content, o = {}) => layoutContent(content, { x: 10, y: 20, width: null, height: null, measurer: fakeMeasurer(), composerFor: () => greedy, breaker: spaceBreaker, ...o });

test('point text: one line per paragraph, first baseline at 0.8 x size, auto leading, measured width', () => {
  const l = lay(M.fromPlain('abcd\nef', { size: 10 }));
  assert.equal(l.engine, 'harfbuzz');
  assert.deepEqual(l.frame, { width: null, height: null });
  assert.equal(l.lines.length, 2);
  assert.equal(l.ascent, 8);
  assert.equal(l.lineHeight, 12);
  assert.deepEqual(l.lines.map((x) => [x.from, x.to, x.text, x.x, x.width, x.top, x.baseline, x.height]), [[0, 4, 'abcd', 10, 20, 20, 28, 12], [5, 7, 'ef', 10, 10, 32, 40, 12]]);
  assert.equal(l.width, 20);
  assert.equal(l.height, 24);
  assert.equal(l.contentHeight, 24);
  assert.equal(l.overflow, false);
});

test('box text wraps at the breaker, trailing spaces hang, a fixed height overflows and hides the lines beyond it', () => {
  const c = M.fromPlain('aaaa bbbb cccc', { size: 10 });
  const l = lay(c, { width: 50 });
  assert.deepEqual(l.lines.map((x) => [x.from, x.to, x.text, x.width]), [[0, 10, 'aaaa bbbb', 45], [10, 14, 'cccc', 20]]);
  assert.equal(l.width, 50);
  assert.equal(l.height, 24);
  const fixed = lay(c, { width: 50, height: 20 });
  assert.deepEqual(fixed.frame, { width: 50, height: 20 });
  assert.equal(fixed.height, 20);
  assert.equal(fixed.contentHeight, 24);
  assert.equal(fixed.overflow, true);
  assert.deepEqual(fixed.lines.map((x) => x.visible), [true, false]);
  const roomy = lay(c, { width: 50, height: 24 });
  assert.equal(roomy.overflow, false);
});

test('alignment, indents and space before / after per paragraph', () => {
  let c = M.fromPlain('ab\ncd\nef', { size: 10 });
  c = M.applyPara(c, 0, 2, { align: 'right', spaceAfter: 3 });
  c = M.applyPara(c, 3, 5, { align: 'center', spaceBefore: 5, indentLeft: 4, indentRight: 6 });
  c = M.applyPara(c, 6, 8, { indentFirst: 7 });
  const l = lay(c, { width: 100 });
  const [a, b, d] = l.lines;
  assert.equal(a.x, 10 + 100 - 10);
  // centred in the width left between the indents
  assert.equal(b.x, 10 + 4 + (100 - 4 - 6 - 10) / 2);
  assert.equal(d.x, 10 + 7);
  assert.equal(a.baseline, 28);
  assert.equal(b.baseline, 28 + 12 + 3 + 5);
  assert.equal(b.top, 40);
  assert.equal(d.baseline, b.baseline + 12);
  assert.equal(l.contentHeight, d.baseline + 4 - 20);
});

test('tabs go to the next multiple of the tab stop from the line start', () => {
  const c = M.fromPlain('a\tbb\tc', { size: 10 }, { tabStop: 20 });
  const l = lay(c);
  const runs = l.lines[0].runs;
  assert.deepEqual(runs.map((r) => [r.from, r.to, r.x, r.advance]), [[0, 1, 10, 5], [1, 2, 15, 15], [2, 4, 30, 10], [4, 5, 40, 10], [5, 6, 50, 5]]);
  assert.equal(l.width, 45);
});

test('leading: auto from the largest size on the line, fixed leading in px, mixed sizes step by each line', () => {
  let c = M.fromPlain('ab\ncd', { size: 10 });
  c = M.applyChar(c, 1, 2, { size: 30 });
  let l = lay(c);
  assert.equal(l.ascent, 24); // 0.8 x 30: the largest size on the first line
  assert.equal(l.lines[0].baseline, 44);
  assert.equal(l.lines[0].height, 36);
  assert.equal(l.lines[1].baseline, 44 + 12); // the second line's own leading
  c = M.applyChar(M.fromPlain('ab\ncd', { size: 10 }), 0, 5, { leading: 20 });
  l = lay(c);
  assert.equal(l.lines[1].baseline - l.lines[0].baseline, 20);
  assert.equal(l.contentHeight, 40);
  // a 0.3 layer: lineHeight 1.5 is auto leading at 150 %
  const old = M.fromLegacy({ text: 'x\ny', font: { size: 10, lineHeight: 1.5 } }).content;
  assert.equal(lay(old).lines[1].baseline - lay(old).lines[0].baseline, 15);
});

test('tracking is added after every cluster but the line\'s last; manual kerning after its character; super / subscript', () => {
  let c = M.fromPlain('abcd', { size: 10, tracking: 100 });
  c = M.applyChar(c, 2, 4, { size: 20 });
  const l = lay(c);
  assert.deepEqual(l.lines[0].runs.map((r) => [r.from, r.to, r.x, r.advance]), [[0, 2, 10, 12], [2, 4, 22, 22]]);
  assert.equal(l.lines[0].width, 34);
  const k = lay(M.applyChar(M.fromPlain('abc', { size: 10 }), 0, 1, { kern: -200 }));
  assert.deepEqual(k.lines[0].runs.map((r) => r.advance), [3, 10]);
  const sup = lay(M.applyChar(M.fromPlain('xy', { size: 10 }), 1, 2, { position: 'super' }));
  const [x, y] = sup.lines[0].runs;
  assert.equal(y.baseline, x.baseline - 3.33);
  assert.equal(y.size, 5.83);
});

test('justification: spaces stretch on every line but the last; a composer\'s justify is applied as given', () => {
  const c = M.applyPara(M.fromPlain('aa bb cc dd', { size: 10 }), 0, 11, { align: 'justify-left' });
  const l = lay(c, { width: 40 });
  assert.equal(l.lines.length, 2);
  assert.equal(l.lines[0].width, 40);
  assert.equal(l.lines[1].width, 25);
  const custom = { id: 'x', compose: ({ from, to }) => [{ from, to, hyphen: false, justify: { wordSpace: 2, letterSpace: 1, glyphScale: 1 } }] };
  const j = lay(M.fromPlain('ab c', { size: 10 }), { width: 100, composerFor: () => custom });
  // natural 20 + one space x 2 + three glyph gaps x 1
  assert.equal(j.lines[0].width, 25);
});

test('lists draw a marker in the indent; a hyphen line end adds the hyphen to the width', () => {
  const c = M.applyPara(M.fromPlain('item', { size: 10 }), 0, 4, { list: { type: 'bullet', marker: '•', start: 1, level: 0 }, indentLeft: 20 });
  const l = lay(c, { listMarker: () => '•' });
  assert.equal(l.lines[0]._marker.from, 0);
  assert.equal(l.lines[0]._marker.x, 10 + 20 - 5 - 2.5);
  const hy = { id: 'h', compose: ({ from, to }) => [{ from, to: from + 3, hyphen: true }, { from: from + 3, to, hyphen: false }] };
  const h = lay(M.fromPlain('abcdef', { size: 10 }), { width: 100, composerFor: () => hy });
  assert.equal(h.lines[0].hyphen, true);
  assert.equal(h.lines[0].width, 20);
  assert.equal(h.lines[0]._hyphen.x, 10 + 15);
});

test('clusters: one per grapheme start, a ligature unit shares its advance', () => {
  const m = fakeMeasurer();
  const lig = { ...m, piece(text, from, to, st) {
    const p = m.piece(text, from, to, st);
    // 'fi' as one unit of 7 px
    const units = [];
    for (let i = from; i < to; i++) {
      if (text.slice(i, i + 2) === 'fi') {
        units.push({ index: i, end: i + 2, advance: 7, kind: 'glyphs', glyphs: [{ id: 1, x: 0, y: 0 }], str: 'fi', size: st.size });
        i++;
      } else units.push(p.units.find((u) => u.index === i));
    }
    return { ...p, units };
  } };
  const l = lay(M.fromPlain('afi', { size: 10, tracking: 100 }), { measurer: lig });
  const run = l.lines[0].runs[0];
  assert.deepEqual(run.units.map((u) => [u.index, u.end]), [[0, 1], [1, 3]]);
  assert.deepEqual(run.clusters.map((c) => [c.index, c.x, c.advance]), [[0, 10, 6], [1, 16, 3.5], [2, 19.5, 3.5]]);
  assert.equal(run.advance, 13);
});

// ---- shaping the OFL test font in Node --------------------------------------------------------------------------------

setHarfBuzz(hb);
addFaces(readFileSync(new URL('../fixtures/fonts/Carlito-Regular.ttf', import.meta.url)), { family: 'Test Carlito' });
const env = { faceFor, measure: (s, st, size) => s.length * size * 0.5 };
const style = (o = {}) => M.resolveChar({ fontFamily: 'Test Carlito', size: 100, ...o });

test('the test face loads with its names, weight, features and metrics', () => {
  const rec = faceFor(style());
  assert.equal(rec.family, 'Test Carlito');
  assert.equal(rec.postScriptName, 'Carlito-Regular');
  assert.equal(rec.weight, 400);
  assert.equal(rec.italic, false);
  assert.ok(rec.features.has('liga') && rec.features.has('kern'));
  assert.equal(faceFor(style({ fontFamily: 'Nope' })), null);
  // bold asked of a regular face is synthesised
  assert.deepEqual(synthesis(rec, style({ fontWeight: 700, fontItalic: true })), { bold: true, italic: true });
  const m = harfBuzzFontProvider.metrics(style());
  assert.ok(m.ascent > 80 && m.descent > 10 && m.capHeight > 55 && m.capHeight < 75);
  assert.ok(m.underlinePosition > 0 && m.strikePosition < 0);
});

test('HarfBuzz shapes ligatures, kerning and an emoji sequence into whole units', () => {
  const office = shapePiece('office', 0, 6, style(), env);
  assert.deepEqual(office.units.map((u) => [u.index, u.end, u.glyphs.length]), [[0, 1, 1], [1, 4, 1], [4, 5, 1], [5, 6, 1]]);
  // kerning between A and V comes from GPOS; 'none' turns it off
  const kerned = shapePiece('AV', 0, 2, style(), env).units[0].advance;
  const plain = shapePiece('AV', 0, 2, style({ autoKern: 'none' }), env).units[0].advance;
  assert.ok(kerned < plain - 1, `${kerned} < ${plain}`);
  // the model's feature overrides reach HarfBuzz
  assert.equal(shapePiece('fi', 0, 2, style({ features: { liga: 0 } }), env).units.length, 2);
  const e = shapePiece('a\u{1F469}\u200D\u{1F469}\u200D\u{1F467}b', 0, 10, style(), env);
  assert.deepEqual(e.units.map((u) => [u.index, u.end, u.kind]), [[0, 1, 'glyphs'], [1, 9, 'fallback'], [9, 10, 'glyphs']]);
  // a combining mark stays with its base
  assert.deepEqual(shapePiece('e\u0301x', 0, 3, style(), env).units.map((u) => [u.index, u.end]), [[0, 2], [2, 3]]);
});

test('caps, scales, fractional widths and the case segments', () => {
  const upper = shapePiece('ab', 0, 2, style({ caps: 'all' }), env);
  const AB = shapePiece('AB', 0, 2, style(), env);
  assert.deepEqual(upper.units.map((u) => u.glyphs[0].id), AB.units.map((u) => u.glyphs[0].id));
  // small caps: Carlito has no smcp, so lower-case letters are capitals at 80 % (B.6) and capitals stay
  const sc = shapePiece('aB', 0, 2, style({ caps: 'small' }), env);
  assert.deepEqual(sc.units.map((u) => u.size), [80, 100]);
  assert.equal(sc.units[0].glyphs[0].id, AB.units[0].glyphs[0].id);
  const segs = caseSegments('aB', 0, 2, 'small', false);
  assert.deepEqual(segs.map((s) => [s.str, s.small]), [['A', true], ['B', false]]);
  const wide = shapePiece('x', 0, 1, style({ scaleX: 200 }), env).units[0].advance;
  const normal = shapePiece('x', 0, 1, style(), env).units[0].advance;
  assert.ok(Math.abs(wide - normal * 2) < 1e-9);
  const whole = shapePiece('x', 0, 1, style({ fractionalWidths: false, size: 13 }), env).units[0].advance;
  assert.equal(whole, Math.round(whole));
  assert.deepEqual(featureList(style({ autoKern: 'none', features: { ss01: 1 } })), [['ss01', 1], ['kern', 0]]);
});

test('right-to-left pieces and direction runs', () => {
  assert.deepEqual(directionRuns('ab אב c', 0, 8), [{ from: 0, to: 3, rtl: false }, { from: 3, to: 6, rtl: true }, { from: 6, to: 8, rtl: false }]);
  assert.deepEqual(directionRuns('12 ab', 0, 5), [{ from: 0, to: 5, rtl: false }]);
});

test('the provider gives outlines as Pigment path data and per-unit advances', () => {
  const o = harfBuzzFontProvider.outline(style(), 'o');
  assert.equal(o.subpaths.length, 2);
  assert.ok(o.subpaths.every((s) => s.closed && s.points.length > 3));
  // y down: an 'o' sits above the baseline (its overshoot dips a little below)
  assert.ok(o.subpaths.every((s) => s.points.every((p) => p.y <= 3)));
  assert.ok(Math.min(...o.subpaths[0].points.map((p) => p.y)) < -40);
  const adv = harfBuzzFontProvider.advances(style(), 'fi');
  assert.equal(adv.length, 2);
  assert.equal(adv[1], 0);
  assert.ok(adv[0] > 40);
  assert.equal(harfBuzzFontProvider.hasFeature(style(), 'liga'), true);
  assert.equal(harfBuzzFontProvider.hasFeature(style({ fontFamily: 'Nope' }), 'liga'), false);
});

test('layout with the real shaper: tracking keeps the ligature, the line width excludes the last tracking', () => {
  const measurer = {
    piece: (text, from, to, st, o = {}) => shapePiece(text, from, to, st, { ...env, ctxFrom: o.ctxFrom, ctxTo: o.ctxTo }),
    hyphen: (st) => shapePiece('-', 0, 1, st, env).units[0].advance,
    marker: (st, s) => shapePiece(s, 0, s.length, st, env).units.reduce((w, u) => w + u.advance, 0),
  };
  const plain = layoutContent(M.fromPlain('fifi', { fontFamily: 'Test Carlito', size: 100 }), { x: 0, y: 0, measurer, composerFor: () => greedy, breaker: spaceBreaker });
  const tracked = layoutContent(M.fromPlain('fifi', { fontFamily: 'Test Carlito', size: 100, tracking: 100 }), { x: 0, y: 0, measurer, composerFor: () => greedy, breaker: spaceBreaker });
  assert.deepEqual(tracked.lines[0].runs[0].units.map((u) => u.glyphs.length), [1, 1]);
  assert.ok(Math.abs(tracked.lines[0].width - plain.lines[0].width - 10) < 1e-9);
  assert.deepEqual(tracked.lines[0].runs[0].clusters.map((c) => c.index), [0, 1, 2, 3]);
});
