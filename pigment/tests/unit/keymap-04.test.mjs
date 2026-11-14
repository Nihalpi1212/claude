// Keymap 0.4 (M.4 "Matching on every keyboard"): Alt bindings match by physical key, so macOS
// Option combos (which change event.key) work; every existing binding still matches its events.
// Step 10 of the skeleton completes it with the table checks of M.4, M.7 and M.8.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MENU_KEYS, RENDERER_KEYS, TYPE_KEYS, COMMAND_LABELS, SHORTCUT_GROUPS, BLEND_MODE_KEYS, parseAccelerator, eventMatches, codeToKey, typeKeyFor, sameAccelerator, runsWhileTyping } from '../../src/shared/keymap.js';

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

/** The key combination an accelerator stands for on a platform (CmdOrCtrl resolved). */
function combo(accel, isMac) {
  const d = parseAccelerator(accel);
  const ctrl = d.ctrl || (d.cmdOrCtrl && !isMac);
  const meta = d.meta || (d.cmdOrCtrl && isMac);
  return `${ctrl ? 'C' : ''}${meta ? 'M' : ''}${d.alt ? 'A' : ''}${d.shift ? 'S' : ''}+${d.key}`;
}

test('no key combination is bound to two commands across MENU_KEYS and RENDERER_KEYS, on either platform', () => {
  for (const isMac of [true, false]) {
    const owner = new Map();
    const add = (cmd, accel) => {
      const k = combo(accel, isMac);
      const prev = owner.get(k);
      assert.ok(!prev || prev === cmd, `${accel}: ${prev} and ${cmd} (mac=${isMac})`);
      owner.set(k, cmd);
    };
    for (const [cmd, accel] of Object.entries(MENU_KEYS)) add(cmd, accel);
    for (const [cmd, list] of Object.entries(RENDERER_KEYS)) for (const accel of list) add(cmd, accel);
  }
});

test('TYPE_KEYS: 36 commands, no combination twice, and each matches its own events', () => {
  assert.equal(Object.keys(TYPE_KEYS).length, 36);
  for (const isMac of [true, false]) {
    const seen = new Map();
    for (const [cmd, accel] of Object.entries(TYPE_KEYS)) {
      const k = combo(accel, isMac);
      assert.ok(!seen.has(k), `${accel}: ${seen.get(k)} and ${cmd}`);
      seen.set(k, cmd);
      assert.ok(eventMatches(eventFor(accel, isMac), parseAccelerator(accel), isMac), `${cmd} ${accel}`);
    }
  }
});

test('typeKeyFor gives exactly the nine collisions of M.4', () => {
  const found = {};
  for (const cmd of new Set([...Object.keys(MENU_KEYS), ...Object.keys(RENDERER_KEYS)])) {
    const t = typeKeyFor(cmd);
    if (t) found[cmd] = t;
  }
  assert.deepEqual(found, {
    'image:auto-tone': 'type:align-left',
    'edit:copy-merged': 'type:align-center',
    'filter:lens-correction': 'type:align-right',
    'layer:via-cut': 'type:align-justify-left',
    'image:auto-color': 'type:toggle-faux-bold',
    'select:inverse': 'type:toggle-faux-italic',
    'image:adjust-desaturate': 'type:toggle-underline',
    'filter:liquify': 'type:reset-scale-x',
    'view:extras': 'type:hide-selection',
  });
  assert.equal(typeKeyFor('type:align-left'), null);
  assert.equal(typeKeyFor('no:such-command'), null);
  assert.ok(sameAccelerator('Shift+CmdOrCtrl+L', 'CmdOrCtrl+Shift+L'));
  assert.ok(!sameAccelerator('CmdOrCtrl+Plus', 'CmdOrCtrl+Shift+='));
});

const DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
// M.7: every new command id and its key ('MENU:' for MENU_KEYS, 'TYPE:' for TYPE_KEYS, null for none)
const M7 = {
  'window:panel-paragraph': null,
  'type:toggle-panels': null,
  'type:reset-character': null,
  'type:reset-paragraph': null, 'type:hyphenation-settings': null, 'type:justification-settings': null,
  ...Object.fromEntries(Object.entries(TYPE_KEYS).map(([id, accel]) => [id, `TYPE:${accel}`])),
  'edit:paste-without-formatting': null,
  'edit:toggle-last-state': 'MENU:CmdOrCtrl+Alt+Z',
  'edit:search': 'MENU:CmdOrCtrl+F',
  'edit:menus': 'MENU:CmdOrCtrl+Alt+Shift+M',
  'image:adjust-color-vibrance': null, 'image:adjust-clarity-dehaze': null, 'image:adjust-grain': null,
  'image:adjust-levels-last': 'CmdOrCtrl+Alt+L', 'image:adjust-curves-last': 'CmdOrCtrl+Alt+M',
  'image:adjust-hue-saturation-last': 'CmdOrCtrl+Alt+U', 'image:adjust-color-balance-last': 'CmdOrCtrl+Alt+B',
  'layer:style-create-layers': null, 'layer:style-toggle-all': null, 'layer:style-scale': null,
  'layer:vector-mask': null,
  'layer:mask-overlay': '\\',
  'layer:mask-overlay-options': null,
  'path:make-mask': null, 'path:make-shape': null,
  'layer:copy-shape-attributes': null, 'layer:paste-shape-attributes': null,
  'layer:collapse-all-groups': null, 'layer:panel-options': null,
  'layer:merge': 'MENU:CmdOrCtrl+E',
  'layer:merge-group': null,
  'layer:arrange-reverse': null,
  'layer:lock-dialog': 'MENU:CmdOrCtrl+/', 'layer:lock-group': null,
  'layer:select-similar': null,
  'layer:new-no-dialog': 'CmdOrCtrl+Alt+Shift+N',
  'layer:stamp-visible': 'CmdOrCtrl+Alt+Shift+E', 'layer:stamp-selected': 'CmdOrCtrl+Alt+E',
  'layer:select-forward': 'Alt+]', 'layer:select-backward': 'Alt+[', 'layer:select-front': 'Alt+.', 'layer:select-back': 'Alt+,',
  'layer:select-add-forward': 'Shift+Alt+]', 'layer:select-add-backward': 'Shift+Alt+[',
  'layer:lock-transparency-toggle': '/',
  ...Object.fromEntries(DIGITS.map((d) => [`layer:opacity-digit-${d}`, d])),
  ...Object.fromEntries(DIGITS.map((d) => [`layer:fill-digit-${d}`, `Shift+${d}`])),
  'layer:blend-next': 'Shift+=', 'layer:blend-prev': 'Shift+-',
  'view:smart-guides': null, 'view:snap-to': null,
  'view:lock-guides': 'MENU:CmdOrCtrl+Alt+;',
  'view:clear-artboard-guides': null, 'view:clear-selected-guides': null, 'view:new-guide-layout': null, 'view:guides-from-shape': null, 'view:edit-selected-guides': null,
  'view:new-guide': null, 'view:clear-guides': null,
  'view:ruler-unit': null, 'view:ruler-origin-reset': null,
  'view:pattern-preview': null,
  'window:panel-gradients': null, 'window:panel-patterns': null,
};
// Photoshop's blend-mode letters (M.4)
const LETTERS = 'NIKMBAGSDWOFHVJZLEXUTCYP';
BLEND_MODE_KEYS.forEach(([id], i) => (M7[`layer:blend-mode-${id}`] = `Shift+Alt+${LETTERS[i]}`));

test('every new command id of M.7 has a label and exactly the key M.7 decides', () => {
  assert.equal(BLEND_MODE_KEYS.length, 24);
  assert.equal(Object.keys(M7).filter((id) => id.startsWith('layer:blend-mode-')).length, 24);
  for (const [id, decision] of Object.entries(M7)) {
    assert.ok(typeof COMMAND_LABELS[id] === 'string' && COMMAND_LABELS[id].length > 0, `label for ${id}`);
    const menu = MENU_KEYS[id] ?? null;
    const renderer = RENDERER_KEYS[id] ?? [];
    const type = TYPE_KEYS[id] ?? null;
    if (decision === null) {
      assert.equal(menu, null, `${id} has no menu key`);
      assert.deepEqual(renderer, [], `${id} has no renderer key`);
      assert.equal(type, null, `${id} has no type key`);
    } else if (decision.startsWith('MENU:')) {
      assert.ok(sameAccelerator(menu, decision.slice(5)), `${id}: ${menu}`);
      assert.deepEqual(renderer, [], `${id} only in MENU_KEYS`);
    } else if (decision.startsWith('TYPE:')) {
      assert.equal(type, decision.slice(5));
      assert.equal(menu, null);
      assert.deepEqual(renderer, []);
    } else {
      assert.equal(menu, null, `${id} is a renderer key`);
      assert.equal(renderer.length, 1, `${id}: ${renderer}`);
      assert.ok(sameAccelerator(renderer[0], decision), `${id}: ${renderer[0]} vs ${decision}`);
    }
  }
});

test('the changed default bindings of M.4 and M.8', () => {
  const menu = (id) => MENU_KEYS[id] ?? null;
  const is = (a, b) => assert.ok(a && sameAccelerator(a, b), `${a} vs ${b}`);
  is(menu('edit:search'), 'CmdOrCtrl+F');
  is(menu('filter:last'), 'CmdOrCtrl+Alt+F');
  is(menu('edit:toggle-last-state'), 'CmdOrCtrl+Alt+Z');
  assert.equal(menu('edit:step-backward'), null);
  assert.equal(menu('edit:step-forward'), null);
  is(menu('view:proof'), 'CmdOrCtrl+Y');
  assert.equal(RENDERER_KEYS['edit:redo'], undefined, 'Ctrl+Y no longer redoes');
  is(menu('file:save-for-web'), 'CmdOrCtrl+Alt+Shift+S');
  is(menu('file:export'), 'CmdOrCtrl+Alt+Shift+W');
  is(menu('file:export-quick'), "CmdOrCtrl+Shift+'");
  is(RENDERER_KEYS['layer:stamp-visible'][0], 'CmdOrCtrl+Alt+Shift+E');
  is(menu('help:shortcuts'), 'CmdOrCtrl+Alt+Shift+K');
  is(menu('layer:lock-dialog'), 'CmdOrCtrl+/');
  is(menu('edit:preferences'), 'CmdOrCtrl+K');
  is(menu('layer:visibility'), 'CmdOrCtrl+,');
  is(menu('layer:merge'), 'CmdOrCtrl+E');
  assert.equal(menu('layer:merge-down'), null, 'layer:merge-down keeps its meaning but loses Ctrl+E');
  // the physical-key fallback lets macOS Option combos reach the new bindings
  assert.ok(eventMatches(ev({ key: 'ƒ', code: 'KeyF', altKey: true, metaKey: true }), parseAccelerator(MENU_KEYS['filter:last']), true));
  assert.ok(eventMatches(ev({ key: '…', code: 'Semicolon', altKey: true, metaKey: true }), parseAccelerator(MENU_KEYS['view:lock-guides']), true));
});

test('SHORTCUT_GROUPS: a Type group with every TYPE_KEYS command, a Layer keys group, and every listed command labelled', () => {
  const type = SHORTCUT_GROUPS.find((g) => g.title === 'Type');
  assert.ok(type?.type, 'Type group marked as type keys');
  assert.deepEqual([...type.commands].sort(), Object.keys(TYPE_KEYS).sort());
  const layerKeys = SHORTCUT_GROUPS.find((g) => g.title === 'Layer keys');
  for (const id of ['layer:select-forward', 'layer:opacity-digit-5', 'layer:fill-digit-0', 'layer:blend-mode-multiply', 'layer:lock-transparency-toggle', 'layer:mask-overlay']) assert.ok(layerKeys.commands.includes(id), id);
  for (const g of SHORTCUT_GROUPS) for (const id of g.commands) assert.ok(COMMAND_LABELS[id], `label for ${id} (${g.title})`);
});

test('non-US layouts: a letter matches by the letter produced, never by the physical position of another letter', () => {
  const all = [];
  for (const [cmd, accel] of Object.entries(MENU_KEYS)) all.push([cmd, parseAccelerator(accel)]);
  for (const [cmd, list] of Object.entries(RENDERER_KEYS)) for (const accel of list) all.push([cmd, parseAccelerator(accel)]);
  const hits = (e, isMac = false) => all.filter(([, d]) => eventMatches(e, d, isMac)).map(([cmd]) => cmd);
  // what the same keys give on a US keyboard
  const expected = (accel) => hits(eventFor(accel, false));
  // AZERTY: the key labelled Z sends code KeyW, the key labelled M code Semicolon
  assert.deepEqual(hits(ev({ key: 'z', code: 'KeyW', ctrlKey: true, altKey: true })), expected('Ctrl+Alt+Z'));
  assert.ok(!hits(ev({ key: 'z', code: 'KeyW', ctrlKey: true, altKey: true })).some((c) => expected('Ctrl+Alt+W').includes(c)));
  assert.deepEqual(hits(ev({ key: 'm', code: 'Semicolon', ctrlKey: true, altKey: true })), expected('Ctrl+Alt+M'));
  // QWERTZ: the key labelled Y sends code KeyZ; Shift+Alt+Y is Luminosity, not the Shift+Alt+Z binding
  assert.deepEqual(hits(ev({ key: 'Y', code: 'KeyZ', shiftKey: true, altKey: true })), expected('Shift+Alt+Y'));
  assert.deepEqual(hits(ev({ key: 'Z', code: 'KeyY', shiftKey: true, altKey: true })), expected('Shift+Alt+Z'));
  // symbols still fall back to the physical key with Shift (US Shift+1 gives "!") and with Option on macOS
  assert.ok(eventMatches(ev({ key: '!', code: 'Digit1', shiftKey: true }), parseAccelerator('Shift+1'), false));
  assert.ok(eventMatches(ev({ key: 'Ω', code: 'KeyZ', altKey: true, metaKey: true }), parseAccelerator('CmdOrCtrl+Alt+Z'), true));
});

test('runsWhileTyping: in a text field only the edit keys and file, view, help and window commands run', () => {
  for (const id of ['edit:undo', 'edit:redo', 'edit:copy', 'edit:paste', 'edit:cut', 'select:all', 'edit:clear', 'file:save', 'view:zoom-in', 'window:panel-layers', 'help:shortcuts']) assert.equal(runsWhileTyping(id), true, id);
  for (const id of ['layer:merge', 'layer:via-copy', 'layer:visibility', 'layer:lock-dialog', 'image:adjust-invert', 'edit:toggle-last-state', 'layer:blend-mode-multiply']) assert.equal(runsWhileTyping(id), false, id);
  assert.equal(COMMAND_LABELS['layer:merge-clipping'], 'Merge clipping mask');
});
