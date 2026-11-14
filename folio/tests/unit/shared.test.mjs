import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePageRanges, formatPageRanges } from '../../src/shared/page-ranges.js';
import { toPdfDate, fromPdfDate } from '../../src/shared/pdf-date.js';
import { annotId, parseAnnotId } from '../../src/shared/pdf-ids.js';
import { DEFAULT_SETTINGS, withDefaults } from '../../src/shared/defaults.js';
import { MENU_KEYS, RENDERER_KEYS, parseAccelerator, eventMatches, describeAccelerator } from '../../src/shared/keymap.js';
import { parseColor, colorToHex, wrapText, fmt, normRect, quadsBounds } from '../../src/shared/appearance.js';

test('page ranges parse and format', () => {
  assert.deepEqual(parsePageRanges('1-3, 5, 8-', 10), [0, 1, 2, 4, 7, 8, 9]);
  assert.deepEqual(parsePageRanges('', 3), [0, 1, 2]);
  assert.deepEqual(parsePageRanges('all', 2), [0, 1]);
  assert.deepEqual(parsePageRanges('3-1', 5), [0, 1, 2]);
  assert.deepEqual(parsePageRanges('2 2 2', 5), [1]);
  assert.throws(() => parsePageRanges('0', 5), /between 1 and 5/);
  assert.throws(() => parsePageRanges('x', 5), /not a page/);
  assert.throws(() => parsePageRanges('7', 5), /between/);
  assert.equal(formatPageRanges([0, 1, 2, 4, 7, 8, 9]), '1-3, 5, 8-10');
  assert.equal(formatPageRanges([]), '');
});

test('pdf dates', () => {
  const d = new Date('2026-10-17T15:30:00Z');
  assert.equal(toPdfDate(d), 'D:20261017153000Z');
  assert.equal(fromPdfDate('D:20261017153000Z').toISOString(), d.toISOString());
  assert.equal(fromPdfDate("D:20261017103000-05'00'").toISOString(), d.toISOString());
  assert.equal(fromPdfDate('D:2026').toISOString(), '2026-01-01T00:00:00.000Z');
  assert.equal(fromPdfDate('garbage'), null);
  assert.equal(fromPdfDate(''), null);
});

test('annotation ids', () => {
  assert.equal(annotId(12), '12R');
  assert.equal(annotId(12, 3), '12R3');
  assert.deepEqual(parseAnnotId('12R'), { num: 12, gen: 0 });
  assert.deepEqual(parseAnnotId('12R3'), { num: 12, gen: 3 });
  assert.equal(parseAnnotId('abc'), null);
});

test('settings defaults overlay stored values and drop wrong types', () => {
  const s = withDefaults({ theme: 'dark', inkThickness: 'bad', unknown: 1, signatures: [{ id: 'x' }], defaultZoom: 1.5 });
  assert.equal(s.theme, 'dark');
  assert.equal(s.inkThickness, DEFAULT_SETTINGS.inkThickness);
  assert.equal(s.unknown, 1);
  assert.deepEqual(s.signatures, [{ id: 'x' }]);
  assert.equal(s.defaultZoom, 1.5);
  assert.notEqual(s.stampPresets, DEFAULT_SETTINGS.stampPresets, 'arrays are copied');
});

test('keymap parsing and matching', () => {
  const d = parseAccelerator('CmdOrCtrl+Shift+Z');
  assert.equal(eventMatches({ key: 'Z', ctrlKey: true, shiftKey: true, metaKey: false, altKey: false }, d, false), true);
  assert.equal(eventMatches({ key: 'z', ctrlKey: false, shiftKey: true, metaKey: true, altKey: false }, d, true), true);
  assert.equal(eventMatches({ key: 'z', ctrlKey: true, shiftKey: false, metaKey: false, altKey: false }, d, false), false);
  assert.equal(eventMatches({ key: '+', ctrlKey: true, shiftKey: false, metaKey: false, altKey: false }, parseAccelerator('CmdOrCtrl+='), false), true);
  assert.equal(eventMatches({ key: 'Home', ctrlKey: false, shiftKey: false, metaKey: false, altKey: false }, parseAccelerator('Home'), false), true);
  assert.equal(eventMatches({ key: 'ArrowLeft', ctrlKey: false, shiftKey: false, metaKey: false, altKey: true }, parseAccelerator('Alt+Left'), false), true);
  assert.equal(describeAccelerator('CmdOrCtrl+Shift+S', true), '⇧⌘S');
  assert.equal(describeAccelerator('CmdOrCtrl+Shift+S', false), 'Ctrl+Shift+S');
  // every menu accelerator must be unique
  const seen = new Set();
  for (const accel of Object.values(MENU_KEYS)) {
    assert.ok(!seen.has(accel), `duplicate accelerator ${accel}`);
    seen.add(accel);
  }
  // plain letter shortcuts must not appear in the native menu
  for (const accel of Object.values(MENU_KEYS)) assert.ok(accel.includes('+') && !/^(Delete|Backspace|Home|End|PageUp|PageDown)$/.test(accel));
  assert.ok(RENDERER_KEYS['app:escape'].includes('Escape'));
});

test('appearance helpers', () => {
  assert.deepEqual(parseColor('#ff0000'), [1, 0, 0]);
  assert.deepEqual(parseColor('#0f0'), [0, 1, 0]);
  assert.deepEqual(parseColor('rgb(0, 0, 255)'), [0, 0, 1]);
  assert.equal(parseColor('none'), null);
  assert.equal(colorToHex([1, 0.5, 0]), '#ff8000');
  assert.equal(fmt(1.23456), '1.235');
  assert.equal(fmt(2), '2');
  assert.equal(fmt(-0.5), '-0.5');
  assert.deepEqual(normRect([10, 20, 5, 2]), [5, 2, 10, 20]);
  assert.deepEqual(quadsBounds([[0, 10, 10, 10, 0, 0, 10, 0], [20, 30, 30, 30, 20, 20, 30, 20]]), [0, 0, 30, 30]);
  const fakeFont = { widthOfTextAtSize: (t, s) => t.length * s * 0.5 };
  const lines = wrapText('one two three four five six', fakeFont, 10, 60);
  assert.ok(lines.length > 1);
  assert.ok(lines.every((l) => fakeFont.widthOfTextAtSize(l, 10) <= 60));
  assert.deepEqual(wrapText('a\nb', fakeFont, 10, 100), ['a', 'b']);
});
