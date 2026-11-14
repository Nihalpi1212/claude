// conventions-shortcuts-fields: the numeric field's expression parser (lib/numeric-field.js, H) and the Search
// palette's matching (lib/command-search.js). Both are pure: no DOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNumericEntry, resolveNumericEntry, roundToStep, stepDecimals } from '../../src/renderer/lib/numeric-field.js';
import { scoreEntry, searchEntries, menuEntries } from '../../src/renderer/lib/command-search.js';

test('arithmetic: 100+50, precedence, brackets, unary minus, decimal comma', () => {
  assert.equal(parseNumericEntry('100+50'), 150);
  assert.equal(parseNumericEntry('100 - 30'), 70);
  assert.equal(parseNumericEntry('2+3*4'), 14);
  assert.equal(parseNumericEntry('(2+3)*4'), 20);
  assert.equal(parseNumericEntry('200/4'), 50);
  assert.equal(parseNumericEntry('10×3'), 30);
  assert.equal(parseNumericEntry('9÷3'), 3);
  assert.equal(parseNumericEntry('-5+2'), -3);
  assert.equal(parseNumericEntry('3--2'), 5);
  assert.equal(parseNumericEntry('1,5*2'), 3);
  assert.equal(parseNumericEntry('.5+.25'), 0.75);
});

test('percent: of the base, of the old value by default, as is in a % field', () => {
  assert.equal(parseNumericEntry('50%', { base: 300 }), 150);
  assert.equal(parseNumericEntry('50%', { old: 80 }), 40);
  assert.equal(parseNumericEntry('50%', { base: () => 1000 }), 500);
  assert.equal(parseNumericEntry('100+10%', { base: 200 }), 120);
  assert.equal(parseNumericEntry('50%', { unit: '%' }), 50);
  // nothing to take a percentage of
  assert.equal(parseNumericEntry('50%'), null);
});

test('units: 2in at 300 ppi is 600 px; mixed units convert to the field unit', () => {
  assert.equal(parseNumericEntry('2in', { unit: 'px', dpi: 300 }), 600);
  assert.equal(parseNumericEntry('2 in', { unit: 'px', dpi: () => 300 }), 600);
  assert.equal(parseNumericEntry('1in+10px', { unit: 'px', dpi: 300 }), 310);
  assert.equal(parseNumericEntry('72pt', { unit: 'px', dpi: 144 }), 144);
  assert.ok(Math.abs(parseNumericEntry('25.4mm', { unit: 'px', dpi: 300 }) - 300) < 1e-9);
  assert.ok(Math.abs(parseNumericEntry('2.54cm', { unit: 'in' }) - 1) < 1e-12);
  assert.equal(parseNumericEntry('300px', { unit: 'in', dpi: 300 }), 1);
  // a field unit that is not a length takes only itself
  assert.equal(parseNumericEntry('45°', { unit: '°' }), 45);
  assert.equal(parseNumericEntry('2in', { unit: '°' }), null);
  // a field that lists its units refuses the others
  assert.equal(parseNumericEntry('2in', { units: ['px', 'pt'], dpi: 72 }), null);
  assert.equal(parseNumericEntry('2pt', { units: ['px', 'pt'], dpi: 144 }), 4);
});

test('invalid input keeps the old value', () => {
  for (const bad of ['', 'abc', '100+', '5**2', '(1+2', '1/0', '2in3', '1.2.3', '10 kg']) {
    assert.equal(parseNumericEntry(bad, { unit: 'px' }), null, bad);
    assert.equal(resolveNumericEntry(bad, 42, { unit: 'px' }), 42, bad);
  }
  assert.equal(resolveNumericEntry('100+50', 42), 150);
});

test('rounding to the step and clamping', () => {
  assert.equal(stepDecimals(1), 0);
  assert.equal(stepDecimals(0.1), 1);
  assert.equal(stepDecimals(0.01), 2);
  assert.equal(stepDecimals(0.05), 2);
  assert.equal(roundToStep(10 / 3, { step: 0.01 }), 3.33);
  assert.equal(roundToStep(150.6, { step: 1, max: 100 }), 100);
  assert.equal(roundToStep(-4, { min: 0 }), 0);
  assert.equal(resolveNumericEntry('2in', 0, { unit: 'px', dpi: 300, max: 500 }), 500);
  assert.equal(resolveNumericEntry('1/3', 0, { step: 0.1 }), 0.3);
});

test('Search: menu entries carry their paths, commands and arguments', () => {
  const entries = menuEntries({ platform: 'linux', state: { hasDocument: true, hasLayer: true } });
  const levels = entries.find((e) => e.id === 'image:adjust-levels');
  assert.ok(levels, 'Levels is listed');
  assert.deepEqual(levels.path, ['Image', 'Adjustments']);
  assert.equal(levels.label, 'Levels…');
  const orient = entries.find((e) => e.id === 'text:orientation' && e.arg === 'vertical');
  assert.ok(orient, 'an item with an argument keeps it');
  // no entry is the search itself, and every entry has a command
  assert.ok(!entries.some((e) => e.id === 'edit:search'));
  assert.ok(entries.every((e) => typeof e.id === 'string' && e.id.includes(':')));
});

test('Search: matching ranks label prefixes first and needs every word', () => {
  const entries = [
    { id: 'a:1', label: 'Gaussian Blur…', path: ['Filter', 'Blur'] },
    { id: 'a:2', label: 'Blur Gallery', path: ['Filter'] },
    { id: 'a:3', label: 'Levels…', path: ['Image', 'Adjustments'] },
    { id: 'a:4', label: 'Surface Blur…', path: ['Filter', 'Blur'] },
  ];
  const r = searchEntries(entries, 'blur');
  assert.deepEqual(r.map((e) => e.id).slice(0, 1), ['a:2']);
  assert.ok(!r.some((e) => e.id === 'a:3'));
  assert.deepEqual(searchEntries(entries, 'gaus blur').map((e) => e.id), ['a:1']);
  assert.deepEqual(searchEntries(entries, 'adjust lev').map((e) => e.id), ['a:3']);
  assert.equal(scoreEntry(entries[2], ['zzz']), 0);
  assert.deepEqual(searchEntries(entries, ''), []);
});

test('Search: on a tie the item nearer the top of the menus wins (Window > Layers before View > Snap To > Layers)', () => {
  const entries = [
    { id: 'view:snap-to', arg: 'layers', label: 'Layers', path: ['View', 'Snap To'] },
    { id: 'window:panel-layers', label: 'Layers', path: ['Window'], kind: 'panel' },
    { id: 'layer:new', label: 'Layer…', path: ['Layer', 'New'] },
    { id: 'edit:undo', label: 'Undo', path: ['Edit'] },
  ];
  assert.deepEqual(searchEntries(entries, 'layers').map((e) => e.id).slice(0, 2), ['window:panel-layers', 'view:snap-to']);
  assert.deepEqual(searchEntries(entries, 'new layer').map((e) => e.id), ['layer:new']);
});

test('Search: a tool or panel of a longer name does not beat the menu command of that name (review 5)', () => {
  // the palette's entries: the menus as they are, the tools and the panels the menus do not list (collectEntries)
  const tools = ['Blur Tool', 'Sharpen Tool', 'Rotate View Tool', 'Gradient Tool'].map((label) => ({ id: `tool:${label}`, label, path: ['Tools'], kind: 'tool' }));
  const entries = [...menuEntries({ platform: 'linux' }), ...tools];
  const top = (q) => {
    const e = searchEntries(entries, q, 1)[0];
    return e && [...e.path, e.label].join(' > ');
  };
  assert.equal(top('blur'), 'Filter > Blur > Blur');
  assert.equal(top('sharpen'), 'Filter > Sharpen > Sharpen…');
  assert.equal(top('rotate'), 'Edit > Transform > Rotate');
  assert.equal(top('gradient'), 'Layer > New Fill Layer > Gradient…');
  assert.equal(top('pattern'), 'Layer > New Fill Layer > Pattern…');
  assert.equal(top('mask'), 'Layer > Layer Mask > Edit Mask');
  // the hunt's case still holds: the Layers panel before View > Snap To > Layers
  assert.equal(top('layers'), 'Window > Layers');
});
