// finish-layer-menu (ARCHITECTURE.md "0.4 features", package 15): the pure Layer menu rules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  neutralFill, neutralName, digitPercent, cycleBlend, arrangeChildren, distributeMoves, panelRows, navigateRow,
  canPlaceWith, BACKGROUND_LOCKED_PROPS, patchProps,
} from '../../src/renderer/lib/layer-menu-model.js';

test('neutral fills: white for darkening modes, black for lightening and difference modes, grey for contrast modes', () => {
  assert.equal(neutralFill('multiply'), '#ffffff');
  assert.equal(neutralFill('color-burn'), '#ffffff');
  assert.equal(neutralFill('divide'), '#ffffff');
  assert.equal(neutralFill('screen'), '#000000');
  assert.equal(neutralFill('linear-dodge'), '#000000');
  assert.equal(neutralFill('difference'), '#000000');
  assert.equal(neutralFill('overlay'), '#808080');
  assert.equal(neutralFill('pin-light'), '#808080');
  for (const m of ['normal', 'dissolve', 'hard-mix', 'hue', 'saturation', 'color', 'luminosity', 'pass-through', 'nonsense']) assert.equal(neutralFill(m), null, m);
  assert.equal(neutralName('soft-light'), '50% gray');
  assert.equal(neutralName('multiply'), 'white');
  assert.equal(neutralName('normal'), null);
});

test('opacity digits: one digit is tens (0 is 100 %), two quick digits are the exact value', () => {
  assert.deepEqual(['1', '2', '5', '9', '0'].map((d) => digitPercent(null, d)), [10, 20, 50, 90, 100]);
  assert.equal(digitPercent('4', '5'), 45);
  assert.equal(digitPercent('0', '5'), 5);
  assert.equal(digitPercent('0', '0'), 0);
  assert.equal(digitPercent('1', '0'), 10);
  assert.equal(digitPercent('9', '9'), 99);
  assert.equal(digitPercent(null, 'x'), null);
  assert.equal(digitPercent(undefined, '3'), 30);
});

test('blend cycling follows the menu order, wraps, and offers Pass Through to groups only', () => {
  const modes = ['normal', 'dissolve', 'darken', 'multiply', 'luminosity'];
  assert.equal(cycleBlend(modes, 'normal', 1), 'dissolve');
  assert.equal(cycleBlend(modes, 'normal', -1), 'luminosity');
  assert.equal(cycleBlend(modes, 'luminosity', 1), 'normal');
  assert.equal(cycleBlend(modes, 'pass-through', 1, { group: true }), 'normal');
  assert.equal(cycleBlend(modes, 'normal', -1, { group: true }), 'pass-through');
  assert.equal(cycleBlend(modes, 'weird', 1), 'normal');
  assert.equal(cycleBlend(modes, 'weird', -1), 'luminosity');
});

test('arrange: several layers move together and keep their order; Reverse swaps them; the floor holds', () => {
  const [a, b, c, d, e] = ['a', 'b', 'c', 'd', 'e'];
  const kids = [a, b, c, d, e]; // bottom -> top
  const pick = (...p) => (x) => p.includes(x);
  assert.deepEqual(arrangeChildren(kids, pick(b, d), 'front'), [a, c, e, b, d]);
  assert.deepEqual(arrangeChildren(kids, pick(b, d), 'back'), [b, d, a, c, e]);
  assert.deepEqual(arrangeChildren(kids, pick(b, d), 'forward'), [a, c, b, e, d]);
  assert.deepEqual(arrangeChildren(kids, pick(b, d), 'backward'), [b, a, d, c, e]);
  // a block already at the top stays, the rest of the block cannot jump over it
  assert.deepEqual(arrangeChildren(kids, pick(d, e), 'forward'), kids);
  assert.equal(arrangeChildren(kids, pick(d, e), 'forward'), kids, 'unchanged: the same array');
  assert.deepEqual(arrangeChildren(kids, pick(c, d), 'forward'), [a, b, e, c, d]);
  assert.deepEqual(arrangeChildren(kids, pick(a, c, e), 'reverse'), [e, b, c, d, a]);
  assert.deepEqual(arrangeChildren(kids, pick(b, c), 'reverse'), [a, c, b, d, e]);
  assert.equal(arrangeChildren(kids, pick(b), 'reverse'), kids);
  // floor 1: the bottom (a Background) never moves and nothing goes below it
  assert.deepEqual(arrangeChildren(kids, pick(d), 'back', 1), [a, d, b, c, e]);
  assert.deepEqual(arrangeChildren(kids, pick(b), 'backward', 1), kids);
  assert.deepEqual(arrangeChildren(kids, pick(a, c), 'front', 1), [a, b, d, e, c]);
  assert.deepEqual(arrangeChildren(kids, pick(a, b, e), 'reverse', 1), [a, e, c, d, b]);
});

test('distribute: edges spread evenly between the outermost two; Horizontally and Vertically even out the gaps', () => {
  const items = [
    { box: { x: 0, y: 0, width: 10, height: 10 } },
    { box: { x: 70, y: 20, width: 30, height: 5 } },
    { box: { x: 30, y: 60, width: 20, height: 20 } },
  ];
  // left edges 0, 30, 70: the middle one goes to 35
  assert.deepEqual(distributeMoves(items, 'left'), [{ dx: 0, dy: 0 }, { dx: 0, dy: 0 }, { dx: 5, dy: 0 }]);
  // right edges 10, 50, 100: middle to 55
  assert.deepEqual(distributeMoves(items, 'right'), [{ dx: 0, dy: 0 }, { dx: 0, dy: 0 }, { dx: 5, dy: 0 }]);
  // centres 5, 40, 85: middle to 45
  assert.deepEqual(distributeMoves(items, 'hcenter'), [{ dx: 0, dy: 0 }, { dx: 0, dy: 0 }, { dx: 5, dy: 0 }]);
  // top edges 0, 20, 60: middle (20) to 30
  assert.deepEqual(distributeMoves(items, 'top').map((m) => m.dy), [0, 10, 0]);
  // bottom edges 10, 25, 80: middle to 45
  assert.deepEqual(distributeMoves(items, 'bottom').map((m) => m.dy), [0, 20, 0]);
  // horizontal spacing: span 0..100, widths 60, gaps 20 -> the 20-wide box starts at 30 (already)
  assert.deepEqual(distributeMoves(items, 'horizontal'), [{ dx: 0, dy: 0 }, { dx: 0, dy: 0 }, { dx: 0, dy: 0 }]);
  const moved = [{ box: { x: 0, y: 0, width: 10, height: 10 } }, { box: { x: 12, y: 0, width: 10, height: 10 } }, { box: { x: 90, y: 0, width: 10, height: 10 } }];
  assert.deepEqual(distributeMoves(moved, 'horizontal').map((m) => m.dx), [0, 33, 0]);
  // vertical spacing: span 0..80, heights 35, gap 22.5 -> boxes at 0, 32.5, 60
  assert.deepEqual(distributeMoves(items, 'vertical').map((m) => m.dy), [0, 13, 0]);
  assert.deepEqual(distributeMoves(items.slice(0, 2), 'left'), [{ dx: 0, dy: 0 }, { dx: 0, dy: 0 }], 'two layers: nothing to spread');
});

test('panel rows and layer navigation: groups before their children, collapsed groups hide theirs, wrapping', () => {
  const mk = (name, extra = {}) => ({ name, children: [], ...extra });
  const bg = mk('bg'), a = mk('a'), g = mk('g', { isGroup: true, expanded: true }), g1 = mk('g1'), g2 = mk('g2'), top = mk('top');
  g.children = [g1, g2];
  const root = { children: [bg, a, g, top] };
  const rows = panelRows(root);
  assert.deepEqual(rows.map((r) => r.name), ['top', 'g', 'g2', 'g1', 'a', 'bg']);
  g.expanded = false;
  assert.deepEqual(panelRows(root).map((r) => r.name), ['top', 'g', 'a', 'bg']);
  g.expanded = true;
  assert.equal(navigateRow(rows, a, 'forward').name, 'g1');
  assert.equal(navigateRow(rows, a, 'backward').name, 'bg');
  assert.equal(navigateRow(rows, top, 'forward').name, 'bg', 'wraps to the bottom');
  assert.equal(navigateRow(rows, bg, 'backward').name, 'top', 'wraps to the top');
  assert.equal(navigateRow(rows, top, 'forward', { wrap: false }), null);
  assert.equal(navigateRow(rows, a, 'front').name, 'top');
  assert.equal(navigateRow(rows, a, 'back').name, 'bg');
  assert.equal(navigateRow([], a, 'forward'), null);
});

test('Background rules: the Background never moves, nothing goes below it, everything else goes anywhere', () => {
  const bg = { name: 'Background' }, a = { name: 'a' }, g = { name: 'g', isGroup: true };
  assert.equal(canPlaceWith(null, [bg], a, 'above'), true, 'no Background: 0.3 behaviour');
  assert.equal(canPlaceWith(bg, [bg], a, 'above'), false);
  assert.equal(canPlaceWith(bg, [bg], g, 'inside'), false);
  assert.equal(canPlaceWith(bg, [a], bg, 'below'), false);
  assert.equal(canPlaceWith(bg, [a], bg, 'inside'), false);
  assert.equal(canPlaceWith(bg, [a], bg, 'above'), true);
  assert.equal(canPlaceWith(bg, [a], g, 'inside'), true);
  assert.deepEqual([...BACKGROUND_LOCKED_PROPS], ['blend', 'opacity', 'fillOpacity', 'mask', 'vectorMask', 'styles', 'position']);
  assert.deepEqual(patchProps({ opacity: 0.5, name: 'x', blend: 'multiply', visible: false }), ['opacity', 'blend']);
});
