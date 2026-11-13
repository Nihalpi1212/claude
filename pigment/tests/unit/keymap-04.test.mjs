// Keymap 0.4 (M.4 "Matching on every keyboard"): Alt bindings match by physical key, so macOS
// Option combos (which change event.key) work; every existing binding still matches its events.
// Step 10 of the skeleton completes this file with the table checks of M.4 and M.8.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MENU_KEYS, RENDERER_KEYS, parseAccelerator, eventMatches, codeToKey } from '../../src/shared/keymap.js';

const ev = (o) => ({ key: '', code: '', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, location: 0, ...o });

test('Option+[ typed as "“" matches Alt+[; Option+\\ matches Alt+\\; Option+] and Option+. too', () => {
  for (const isMac of [true, false]) {
    assert.ok(eventMatches(ev({ key: '“', code: 'BracketLeft', altKey: true }), parseAccelerator('Alt+['), isMac));
    assert.ok(eventMatches(ev({ key: '‘', code: 'BracketRight', altKey: true }), parseAccelerator('Alt+]'), isMac));
    assert.ok(eventMatches(ev({ key: '«', code: 'Backslash', altKey: true }), parseAccelerator('Alt+\\'), isMac));
    assert.ok(eventMatches(ev({ key: '≥', code: 'Period', altKey: true }), parseAccelerator('Alt+.'), isMac));
    assert.ok(eventMatches(ev({ key: '≤', code: 'Comma', altKey: true }), parseAccelerator('Alt+,'), isMac));
    // Shift+Option letters (the blend-mode keys of finish-layer-menu)
    assert.ok(eventMatches(ev({ key: 'ˆ', code: 'KeyN', altKey: true, shiftKey: true }), parseAccelerator('Shift+Alt+N'), isMac));
    assert.ok(eventMatches(ev({ key: 'Ï', code: 'KeyF', altKey: true, shiftKey: true }), parseAccelerator('Shift+Alt+F'), isMac));
  }
  // the modifiers still have to agree
  assert.ok(!eventMatches(ev({ key: '“', code: 'BracketLeft', altKey: true, shiftKey: true }), parseAccelerator('Alt+['), true));
  assert.ok(!eventMatches(ev({ key: '[', code: 'BracketLeft' }), parseAccelerator('Alt+['), true));
  // without Alt or Shift the key value decides, as in 0.3 (a layout-dependent plain key)
  assert.ok(!eventMatches(ev({ key: 'ö', code: 'BracketLeft' }), parseAccelerator('['), false));
  assert.ok(eventMatches(ev({ key: '[', code: 'Digit8', altKey: false }), parseAccelerator('['), false));
});

test('codeToKey maps the physical keys the 0.4 bindings use', () => {
  assert.equal(codeToKey('Backslash'), '\\');
  assert.equal(codeToKey('Period'), '.');
  assert.equal(codeToKey('Comma'), ',');
  assert.equal(codeToKey('Slash'), '/');
  assert.equal(codeToKey('Quote'), "'");
  assert.equal(codeToKey('Semicolon'), ';');
  assert.equal(codeToKey('KeyQ'), 'q');
  assert.equal(codeToKey('Digit7'), '7');
  assert.equal(codeToKey('F5'), null);
});

const KEY_OF = { arrowup: 'ArrowUp', arrowdown: 'ArrowDown', arrowleft: 'ArrowLeft', arrowright: 'ArrowRight', escape: 'Escape', enter: 'Enter', tab: 'Tab', backspace: 'Backspace', delete: 'Delete', ' ': ' ' };
const CODE_OF = { '[': 'BracketLeft', ']': 'BracketRight', ';': 'Semicolon', "'": 'Quote', '\\': 'Backslash', '=': 'Equal', '-': 'Minus', ',': 'Comma', '.': 'Period', '/': 'Slash', '+': 'Equal' };

/** The KeyboardEvent a US keyboard sends for an accelerator. */
function eventFor(accel, isMac) {
  const d = parseAccelerator(accel);
  let key = d.key, code = '', location = 0;
  if (key === 'numpad+' || key === 'numpad-') {
    location = 3;
    key = key.slice(-1);
    code = key === '+' ? 'NumpadAdd' : 'NumpadSubtract';
  } else if (/^[a-z]$/.test(key)) code = `Key${key.toUpperCase()}`;
  else if (/^\d$/.test(key)) code = `Digit${key}`;
  else if (CODE_OF[key]) code = CODE_OF[key];
  key = KEY_OF[key] ?? key;
  return ev({
    key, code, location,
    ctrlKey: d.ctrl || (d.cmdOrCtrl && !isMac),
    metaKey: d.meta || (d.cmdOrCtrl && isMac),
    altKey: d.alt, shiftKey: d.shift,
  });
}

test('every binding of MENU_KEYS and RENDERER_KEYS still matches its own events on both platforms', () => {
  const all = [];
  for (const [cmd, accel] of Object.entries(MENU_KEYS)) all.push([cmd, accel]);
  for (const [cmd, list] of Object.entries(RENDERER_KEYS)) for (const accel of list) all.push([cmd, accel]);
  assert.ok(all.length > 40);
  for (const isMac of [true, false]) {
    for (const [cmd, accel] of all) {
      // Ctrl+Tab style bindings name Ctrl explicitly: on macOS too
      assert.ok(eventMatches(eventFor(accel, isMac), parseAccelerator(accel), isMac), `${cmd} ${accel} mac=${isMac}`);
    }
  }
});

test('a binding does not match the events of another binding (no new collisions from the fallback)', () => {
  const all = [];
  for (const [cmd, accel] of Object.entries(MENU_KEYS)) all.push([cmd, accel]);
  for (const [cmd, list] of Object.entries(RENDERER_KEYS)) for (const accel of list) all.push([cmd, accel]);
  for (const isMac of [true, false]) {
    for (const [cmdA, accelA] of all) {
      const e = eventFor(accelA, isMac);
      for (const [cmdB, accelB] of all) {
        if (cmdA === cmdB) continue;
        const descA = parseAccelerator(accelA), descB = parseAccelerator(accelB);
        if (JSON.stringify(descA) === JSON.stringify(descB)) continue;
        assert.ok(!eventMatches(e, descB, isMac), `${accelA} (${cmdA}) also matches ${accelB} (${cmdB}) mac=${isMac}`);
      }
    }
  }
});
