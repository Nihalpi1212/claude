// type-character-panel (0.4, package 3): type unit conversions, what the fields show for mixed values, the preset
// lists, Reset Character, the language list and optical kerning on synthetic outlines.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  typeUnit, toUnit, fromUnit, formatNumber, showLength, showNumber, sizePresets, SIZE_PRESETS, SPACING_PRESETS,
  showLeading, toggleState, styleValue, styleToChar, resetCharacterPatch, RESET_KEEPS, documentLanguages, languageOptions,
  autoLeadingPx,
} from '../../src/renderer/lib/type/char-values.js';
import { flattenPath, glyphProfile, pairGap, referenceTarget, opticalKerning } from '../../src/renderer/lib/type/optical-kerning.js';
import * as M from '../../src/renderer/lib/type/model.js';

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

// ---- units ---------------------------------------------------------------------------------------------------------

test('type units: pt and mm convert with the document resolution, the model stays in px', () => {
  // 12 pt at 300 ppi is 50 px; at 72 ppi a point is a pixel
  close(fromUnit(12, 'pt', 300), 50);
  close(toUnit(50, 'pt', 300), 12);
  close(fromUnit(12, 'pt', 72), 12);
  // 25.4 mm is an inch
  close(fromUnit(25.4, 'mm', 300), 300);
  close(toUnit(300, 'mm', 300), 25.4);
  close(fromUnit(7, 'px', 300), 7);
  // round trips
  for (const u of ['px', 'pt', 'mm']) for (const dpi of [72, 96, 150, 300]) close(fromUnit(toUnit(123.45, u, dpi), u, dpi), 123.45, 1e-9);
  // a missing or broken resolution counts as 72 ppi
  close(fromUnit(12, 'pt', 0), 12);
  close(fromUnit(12, 'pt', undefined), 12);
  assert.equal(typeUnit({ type: { unit: 'pt' } }), 'pt');
  assert.equal(typeUnit({ type: { unit: 'in' } }), 'px');
  assert.equal(typeUnit({}), 'px');
});

test('fields show lengths in the unit, at most two decimals, and blank for mixed values', () => {
  assert.equal(showLength(50, 'pt', 300), '12');
  assert.equal(showLength(48, 'px', 300), '48');
  assert.equal(showLength(10, 'mm', 300), '0.85');
  assert.equal(showLength(M.MIXED, 'pt', 300), '');
  assert.equal(showLength(undefined, 'pt', 300), '');
  assert.equal(showNumber(M.MIXED), '');
  assert.equal(showNumber(-0), '0');
  assert.equal(showNumber(12.3456), '12.35');
  assert.equal(formatNumber(-0.001, 2), '0');
  assert.equal(showLeading('auto', 'pt', 300), 'auto');
  assert.equal(showLeading(M.MIXED, 'pt', 300), '');
  assert.equal(showLeading(62.5, 'pt', 300), '15');
  close(autoLeadingPx(40), 48);
  close(autoLeadingPx(40, 150), 60);
});

test('mixed values: toggles report mixed, the style select goes blank', () => {
  const content = M.applyChar(M.fromPlain('Hello world', { size: 40 }), 0, 5, { fauxBold: true, fontWeight: 700 });
  const range = M.charAttrs(content, 0, 11);
  assert.equal(toggleState(range, 'fauxBold'), 'mixed');
  assert.equal(toggleState(M.charAttrs(content, 0, 5), 'fauxBold'), true);
  assert.equal(toggleState(M.charAttrs(content, 6, 11), 'fauxBold'), false);
  assert.equal(toggleState(M.charAttrs(content, 0, 5), 'caps', 'all'), false);
  assert.equal(styleValue(range), '');
  assert.equal(styleValue(M.charAttrs(content, 0, 5)), '700');
  assert.equal(styleValue({ fontWeight: 400, fontItalic: true }), '400i');
  assert.deepEqual(styleToChar('700i'), { fontWeight: 700, fontItalic: true, postScriptName: undefined });
  assert.equal(showLength(range.size, 'px', 72), '40');
  assert.equal(showLength(M.charAttrs(M.applyChar(content, 0, 2, { size: 20 }), 0, 11).size, 'px', 72), '');
});

test('preset lists: Photoshop\'s sizes in the unit; tracking and kerning values', () => {
  assert.deepEqual(SIZE_PRESETS, [6, 7, 8, 9, 10, 11, 12, 14, 18, 24, 30, 36, 48, 60, 72]);
  const pt = sizePresets('pt', 300);
  assert.equal(pt[6].label, '12 pt');
  close(pt[6].px, 50);
  const px = sizePresets('px', 300);
  assert.equal(px[0].label, '6 px');
  close(px[0].px, 6);
  // millimetres: the point sizes converted (12 pt = 4.23 mm)
  const mm = sizePresets('mm', 300);
  assert.equal(mm[6].label, '4.23 mm');
  close(mm[6].px, 50);
  assert.ok(SPACING_PRESETS.includes(-100) && SPACING_PRESETS.includes(200) && SPACING_PRESETS.includes(0));
});

test('Reset Character resets every panel attribute and keeps the face, size, colour and stroke', () => {
  const patch = resetCharacterPatch();
  for (const k of RESET_KEEPS) assert.ok(!(k in patch), k);
  for (const k of ['leading', 'tracking', 'kern', 'autoKern', 'scaleX', 'scaleY', 'baselineShift', 'fauxBold', 'fauxItalic', 'caps', 'position', 'underline', 'strike', 'language', 'fractionalWidths', 'noBreak', 'features']) {
    assert.ok(k in patch && patch[k] === undefined, k);
  }
  let c = M.fromPlain('Hello', { size: 30, color: '#ff0000', fontFamily: 'Georgia' });
  c = M.applyChar(c, 0, 5, { tracking: 50, scaleX: 80, caps: 'all', underline: true, baselineShift: 3, leading: 40, language: 'de' });
  const out = M.charStyleAt(M.applyChar(c, 0, 5, patch), 0);
  assert.equal(out.tracking, 0);
  assert.equal(out.scaleX, 100);
  assert.equal(out.caps, 'normal');
  assert.equal(out.underline, false);
  assert.equal(out.leading, 'auto');
  assert.equal(out.language, 'en-US');
  assert.equal(out.size, 30);
  assert.equal(out.color, '#ff0000');
  assert.equal(out.fontFamily, 'Georgia');
});

test('the Language list: hyphenation languages plus the document\'s, the default always there', () => {
  const a = M.applyChar(M.fromPlain('Hallo Welt'), 0, 5, { language: 'de' });
  const b = M.fromPlain('', { language: 'fr' });
  assert.deepEqual(documentLanguages([a, b]), ['de', 'en-US', 'fr']);
  const opts = languageOptions(['en-GB', 'nl'], ['de', 'en-US'], 'it');
  const values = opts.map((o) => o.value).sort();
  assert.deepEqual(values, ['de', 'en-GB', 'en-US', 'it', 'nl']);
  // sorted by their readable names
  const labels = opts.map((o) => o.label);
  assert.deepEqual(labels, [...labels].sort((x, y) => x.localeCompare(y)));
  assert.deepEqual(languageOptions([], [], M.MIXED).map((o) => o.value), ['en-US']);
});

// ---- optical kerning -------------------------------------------------------------------------------------------------

/** A rectangle outline (px, y down, baseline at 0). */
const rect = (x0, x1, y0, y1) => ({ subpaths: [{ closed: true, points: [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }] }] });
const union = (...paths) => ({ subpaths: paths.flatMap((p) => p.subpaths) });
const SIZE = 100;

test('outlines flatten (cubic segments included) and give horizontal profiles per band', () => {
  const flat = flattenPath(rect(10, 20, -70, 0));
  assert.equal(flat.length, 1);
  assert.equal(flat[0].length, 10); // 4 corners + the closing segment back to the start
  const curve = { subpaths: [{ closed: true, points: [{ x: 0, y: 0, outX: 0, outY: -50 }, { x: 50, y: -50, inX: 50, inY: 0 }] }] };
  assert.equal(flattenPath(curve, 8)[0].length, 2 + 8 * 2 + 2);
  const p = glyphProfile(rect(10, 20, -70, 0), { size: SIZE });
  assert.equal(p.ink, true);
  assert.equal(p.minX, 10);
  assert.equal(p.maxX, 20);
  // bands from -100 to +30 px in 40 steps: the ones inside the rectangle hold its edges, the rest none
  let inside = 0;
  for (let j = 0; j < p.bands; j++) {
    const yc = -100 + (j + 0.5) * (130 / 40);
    if (yc > -70 && yc < 0) {
      inside++;
      assert.equal(p.left[j], 10);
      assert.equal(p.right[j], 20);
    } else if (yc < -71 || yc > 1) assert.ok(Number.isNaN(p.left[j]));
  }
  assert.ok(inside > 15);
  assert.equal(glyphProfile(null, { size: SIZE }).ink, false);
  assert.equal(glyphProfile({ subpaths: [] }, { size: SIZE }).ink, false);
});

test('a pair\'s gap: the mean over inked bands with limited depth, and the closest raw gap', () => {
  const I = glyphProfile(rect(10, 20, -70, 0), { size: SIZE });
  const g = pairGap(I, I, 30, 15);
  close(g.mean, 20);
  close(g.closest, 20);
  // a glyph without ink in some bands counts as `depth` deep there
  const low = glyphProfile(rect(10, 20, -30, 0), { size: SIZE });
  const g2 = pairGap(I, low, 30, 15);
  assert.ok(g2.mean > 20, `${g2.mean}`);
  close(g2.closest, 20);
});

test('optical kerning: evenly spaced stems stay, loose pairs tighten, tight pairs open, nothing collides', () => {
  const I = { outline: rect(10, 20, -70, 0), advance: 30 };
  const target = referenceTarget([I], { size: SIZE });
  close(target, 20);
  // three stems spaced like the reference: no change
  assert.deepEqual(opticalKerning([I, I, I], { size: SIZE, target }), [0, 0, 0]);
  // a stem with a wide right side bearing tightens toward the target (limited to 0.25 em)
  const wide = { outline: rect(10, 20, -70, 0), advance: 45 };
  const k = opticalKerning([wide, I], { size: SIZE, target });
  assert.equal(k[0], -150);
  assert.equal(k[1], 0);
  const far = { outline: rect(10, 20, -70, 0), advance: 90 };
  assert.equal(opticalKerning([far, I], { size: SIZE, target })[0], -250);
  // a stem set too close opens up
  const tight = { outline: rect(10, 20, -70, 0), advance: 22 };
  assert.ok(opticalKerning([tight, I], { size: SIZE, target })[0] > 0);
  // a T (bar above, stem in the middle) before a short o: the o moves under the bar, but its ink never comes closer to
  // the stem than 2 % of an em
  const T = { outline: union(rect(0, 40, -70, -60), rect(15, 25, -60, 0)), advance: 40 };
  const o = { outline: rect(5, 25, -40, 0), advance: 30 };
  const kT = opticalKerning([T, o], { size: SIZE, target })[0];
  assert.ok(kT < 0, `${kT}`);
  const closest = 40 + 5 - 25 + (kT / 1000) * SIZE;
  assert.ok(closest >= 2 - 1e-9, `${closest}`);
  // a space (no ink) and a glyph without an outline are left alone
  const space = { outline: { subpaths: [] }, advance: 25 };
  assert.deepEqual(opticalKerning([I, space, I], { size: SIZE, target }), [0, 0, 0]);
  assert.deepEqual(opticalKerning([I, { outline: null, advance: 30 }, I], { size: SIZE, target }), [0, 0, 0]);
  // results are 1/1000 em of `em` (a superscript draws at 58.3 % of its run's size)
  const em = opticalKerning([wide, I], { size: SIZE, em: 200, target });
  assert.equal(em[0], -75);
});

test('the reference target falls back to 0.12 em without n and o', () => {
  close(referenceTarget([], { size: 50 }), 6);
  close(referenceTarget([{ outline: null, advance: 10 }], { size: 50 }), 6);
  const n = { outline: union(rect(5, 10, -50, 0), rect(25, 30, -50, 0), rect(5, 30, -50, -45)), advance: 35 };
  close(referenceTarget([n], { size: 100 }), 10);
});
