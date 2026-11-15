// type-editing (0.4, package 2): selection levels with Intl.Segmenter, the session undo stack, the clipboard merge
// rules and the pure bodies of the TYPE_KEYS commands.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  graphemeStops, snapToCluster, nextCluster, prevCluster, wordRange, nextWord, prevWord, paragraphRange, lineRange, lineAt,
  unitRange, extendByUnit, nextClickCount, ordered,
} from '../../src/renderer/lib/type/edit-selection.js';
import { EditStack } from '../../src/renderer/lib/type/edit-history.js';
import { clipText, normalizeSystemText, makeClip, setInAppClip, inAppClip, choosePaste, applyPaste } from '../../src/renderer/lib/type/clipboard.js';
import { typeCommandFor, TYPE_COMMANDS, mapCharRuns, kernStep, leadingPx } from '../../src/renderer/lib/type/edit-keys.js';
import { TYPE_KEYS } from '../../src/shared/keymap.js';
import * as M from '../../src/renderer/lib/type/model.js';

// ---- selection ---------------------------------------------------------------------------------------------------

test('the caret steps over whole grapheme clusters (ZWJ emoji, combining marks, surrogate pairs)', () => {
  const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}'; // one cluster of 8 UTF-16 units
  const t = `a${family}e\u0301b`; // "a", the family, "é" as e + combining acute, "b"
  assert.deepEqual(graphemeStops(t), [0, 1, 1 + family.length, 3 + family.length, 4 + family.length, t.length].filter((v, i, a) => a.indexOf(v) === i));
  assert.equal(nextCluster(t, 1), 1 + family.length);
  assert.equal(prevCluster(t, 1 + family.length), 1);
  assert.equal(nextCluster(t, 1 + family.length), 3 + family.length); // e + U+0301 is one step
  assert.equal(prevCluster(t, 3 + family.length), 1 + family.length);
  assert.equal(snapToCluster(t, 4), 1); // inside the family: its start
  assert.equal(snapToCluster(t, 2 + family.length), 1 + family.length); // between e and its accent
  assert.equal(nextCluster(t, t.length), t.length);
  assert.equal(prevCluster(t, 0), 0);
});

test('a double-click selects the word, the run of spaces or the punctuation under it', () => {
  const t = 'Hello,  big world.\nNext line';
  assert.deepEqual(wordRange(t, 0), [0, 5]);
  assert.deepEqual(wordRange(t, 3), [0, 5]);
  assert.deepEqual(wordRange(t, 5), [0, 5]); // at the end of a word: that word
  assert.deepEqual(wordRange(t, 6), [6, 8]); // the two spaces
  assert.deepEqual(wordRange(t, 9), [8, 11]);
  assert.deepEqual(wordRange(t, 14), [12, 17]);
  assert.deepEqual(wordRange(t, 19), [19, 23]); // the next paragraph's first word, not across the '\n'
  // CJK words come from Intl.Segmenter's dictionary, not from spaces
  const ja = '日本語のテキスト';
  const [a, b] = wordRange(ja, 1);
  assert.ok(a === 0 && b >= 2 && b < ja.length, `a Japanese word inside the text: ${a}..${b}`);
});

test('word moves stop at word starts; Home/End lines and paragraphs', () => {
  const t = 'one two  three\nfour';
  assert.equal(nextWord(t, 0), 4);
  assert.equal(nextWord(t, 4), 9);
  assert.equal(nextWord(t, 9), 14); // the paragraph end is a stop
  assert.equal(nextWord(t, 14), 15);
  assert.equal(nextWord(t, 0, { toEnd: true }), 3);
  assert.equal(prevWord(t, 14), 9);
  assert.equal(prevWord(t, 9), 4);
  assert.equal(prevWord(t, 15), 14);
  assert.equal(prevWord(t, 2), 0);
  assert.deepEqual(paragraphRange(t, 3), [0, 14]);
  assert.deepEqual(paragraphRange(t, 16), [15, 19]);
  assert.deepEqual(paragraphRange(t, 14), [0, 14]);
});

test('selection levels: 1 caret, 2 word, 3 line, 4 paragraph, 5 all; line ranges follow the layout and affinity', () => {
  const t = 'Hello world\nSecond para here';
  // the layout of a 150 px box (B.3): "Hello " / "world" / "Second " / "para " / "here"
  const lines = [{ index: 0, from: 0, to: 6 }, { index: 1, from: 6, to: 11, last: true }, { index: 2, from: 12, to: 19 }, { index: 3, from: 19, to: 24 }, { index: 4, from: 24, to: 28, last: true }];
  assert.deepEqual(unitRange(1, t, 8, { lines }), [8, 8]);
  assert.deepEqual(unitRange(2, t, 8, { lines }), [6, 11]);
  assert.deepEqual(unitRange(3, t, 8, { lines }), [6, 11]);
  assert.deepEqual(unitRange(3, t, 20, { lines }), [19, 24]);
  assert.deepEqual(unitRange(4, t, 20, { lines }), [12, 28]);
  assert.deepEqual(unitRange(5, t, 20, { lines }), [0, 28]);
  assert.deepEqual(unitRange(3, t, 20), [12, 28]); // no layout (text on a path): the paragraph
  // a caret at a soft wrap: leading belongs to the next line, trailing to the line that ends there
  assert.deepEqual(lineRange(lines, 6, 'leading'), [6, 11]);
  assert.deepEqual(lineRange(lines, 6, 'trailing'), [0, 6]);
  assert.equal(lineAt(lines, 11).index, 1);
  assert.equal(lineAt(lines, 28).index, 4);
});

test('multi-click counting and drag by unit', () => {
  let c = null;
  const click = (t, x = 10, y = 10) => (c = { t, x, y, count: nextClickCount(c, { t, x, y }) }).count;
  assert.equal(click(0), 1);
  assert.equal(click(200), 2);
  assert.equal(click(400), 3);
  assert.equal(click(600), 4);
  assert.equal(click(800), 5);
  assert.equal(click(1000), 1); // a sixth click starts again
  assert.equal(click(1200), 2);
  assert.equal(click(2000), 1); // too slow
  assert.equal(click(2100, 30, 10), 1); // too far
  // a word drag keeps whole words on both sides
  assert.deepEqual(extendByUnit([6, 11], [12, 18]), { anchor: 6, focus: 18 });
  assert.deepEqual(extendByUnit([6, 11], [0, 5]), { anchor: 11, focus: 0 });
  assert.deepEqual(extendByUnit([6, 11], [6, 11]), { anchor: 6, focus: 11 });
  assert.deepEqual(ordered({ anchor: 9, focus: 2 }), [2, 9]);
});

// ---- session undo stack ------------------------------------------------------------------------------------------

test('the session undo stack merges a typing run, seals on caret moves and drops redo on a new edit', () => {
  let t = 0;
  const s = new EditStack({ clock: () => t });
  assert.equal(s.undo(), null);
  s.record('a0', 'a1', { kind: 'typing' });
  t += 100;
  s.record('a1', 'a2', { kind: 'typing' }); // merges: one step a0 -> a2
  assert.equal(s.steps.length, 1);
  s.seal(); // the caret moved
  s.record('a2', 'a3', { kind: 'typing' });
  assert.equal(s.steps.length, 2);
  t += 100;
  s.record('a3', 'b1', { kind: 'cmd:Faux Bold', merge: false });
  t += 100;
  s.record('b1', 'b2', { kind: 'cmd:Font Size' });
  t += 100;
  s.record('b2', 'b3', { kind: 'cmd:Font Size' }); // a held Shift+Ctrl+. merges
  assert.equal(s.steps.length, 4);
  t += 5000;
  s.record('b3', 'b4', { kind: 'cmd:Font Size' }); // too late to merge
  assert.equal(s.steps.length, 5);
  assert.equal(s.undo(), 'b3');
  assert.equal(s.undo(), 'b1');
  assert.equal(s.undo(), 'a3');
  assert.equal(s.redo(), 'b1');
  assert.ok(s.canRedo);
  s.record('b1', 'c1', { kind: 'typing' }); // a new edit: the redo branch goes
  assert.ok(!s.canRedo);
  assert.equal(s.steps.length, 4);
  assert.equal(s.undo(), 'b1');
  assert.equal(s.undo(), 'a3');
  assert.equal(s.undo(), 'a2');
  assert.equal(s.undo(), 'a0');
  assert.equal(s.undo(), null);
  assert.ok(!s.canUndo);
  // the step after an undo never merges into the undone one
  s.record('a0', 'z', { kind: 'typing' });
  assert.equal(s.steps.length, 1);
});

test('the session undo stack keeps at most `limit` steps', () => {
  const s = new EditStack({ limit: 3 });
  for (let i = 0; i < 5; i++) s.record(i, i + 1, { merge: false });
  assert.equal(s.steps.length, 3);
  assert.equal(s.undo(), 4);
  assert.equal(s.undo(), 3);
  assert.equal(s.undo(), 2);
  assert.equal(s.undo(), null);
});

// ---- clipboard ---------------------------------------------------------------------------------------------------

const twoRuns = () => M.applyChar(M.fromPlain('Hello World', { size: 40, color: '#ff0000' }), 6, 11, { color: '#0000ff', underline: true });

test('copy keeps the runs in the in-app clipboard and writes plain text; forced line breaks become line feeds', () => {
  const c = twoRuns();
  const clip = makeClip(c, 3, 9);
  assert.equal(clip.text, 'lo Wor');
  assert.deepEqual(M.runsIn(clip.content).map((r) => [r.to - r.from, r.style.color, r.style.underline]), [[3, '#ff0000', false], [3, '#0000ff', true]]);
  assert.equal(clipText(M.fromPlain('a\u2028b\nc')), 'a\nb\nc');
  assert.equal(normalizeSystemText('a\r\nb\rc\0'), 'a\nb\nc');
  setInAppClip(clip);
  assert.equal(inAppClip().text, 'lo Wor');
});

test('paste merge rules: the in-app content while the system text still matches, else the system text', () => {
  const clip = makeClip(twoRuns(), 3, 9);
  assert.equal(choosePaste(clip, 'lo Wor').kind, 'formatted');
  assert.equal(choosePaste(clip, 'lo Wor'.replace('\n', '\r\n')).kind, 'formatted');
  assert.equal(choosePaste(clip, null).kind, 'formatted'); // no access to the system clipboard
  assert.deepEqual(choosePaste(clip, 'something else'), { kind: 'plain', text: 'something else' });
  assert.deepEqual(choosePaste(clip, 'lo Wor', { plain: true }), { kind: 'plain', text: 'lo Wor' });
  assert.deepEqual(choosePaste(null, 'x\r\ny'), { kind: 'plain', text: 'x\ny' });
  assert.equal(choosePaste(null, ''), null);
  assert.equal(choosePaste(null, null), null);
});

test('a formatted paste inserts both runs; a plain one takes the style at the caret and splits paragraphs', () => {
  const clip = makeClip(twoRuns(), 3, 9);
  const target = M.fromPlain('ABCD', { size: 20, color: '#00ff00' });
  const f = applyPaste(target, 2, 2, choosePaste(clip, 'lo Wor'));
  assert.equal(M.plainText(f.content), 'ABlo WorCD');
  assert.equal(f.caret, 8);
  assert.deepEqual(M.runsIn(f.content).map((r) => [r.to - r.from, r.style.color, r.style.size]), [[2, '#00ff00', 20], [3, '#ff0000', 40], [3, '#0000ff', 40], [2, '#00ff00', 20]]);
  const p = applyPaste(target, 1, 3, choosePaste(clip, 'x\ny'));
  assert.equal(M.plainText(p.content), 'Ax\nyD');
  assert.equal(p.caret, 4);
  assert.equal(p.content.paras.length, 2);
  assert.ok(M.runsIn(p.content).every((r) => r.style.color === '#00ff00'));
  // the caret's insertion style (a sparse style) goes on plain pasted text
  const s = applyPaste(target, 4, 4, { kind: 'plain', text: '!' }, { style: { size: 20, color: '#123456' } });
  assert.equal(M.charStyleAt(s.content, 4).color, '#123456');
});

// ---- TYPE_KEYS ---------------------------------------------------------------------------------------------------

const ev = (key, mods = {}, code) => ({ key, code: code ?? (key.length === 1 && /[a-z]/i.test(key) ? `Key${key.toUpperCase()}` : ''), ctrlKey: !!mods.ctrl, metaKey: !!mods.meta, altKey: !!mods.alt, shiftKey: !!mods.shift, location: 0 });

test('every TYPE_KEYS command has a body, and keydowns map to the right one on Windows/Linux and macOS', () => {
  for (const id of Object.keys(TYPE_KEYS)) assert.ok(TYPE_COMMANDS[id], id);
  assert.equal(typeCommandFor(ev('>', { ctrl: true, shift: true }, 'Period')), 'type:size-up');
  assert.equal(typeCommandFor(ev('>', { ctrl: true, shift: true, alt: true }, 'Period')), 'type:size-up-10');
  assert.equal(typeCommandFor(ev('<', { ctrl: true, shift: true }, 'Comma')), 'type:size-down');
  assert.equal(typeCommandFor(ev('L', { ctrl: true, shift: true })), 'type:align-left');
  assert.equal(typeCommandFor(ev('L', { meta: true, shift: true }), true), 'type:align-left');
  assert.equal(typeCommandFor(ev('L', { meta: true, shift: true }), false), null);
  assert.equal(typeCommandFor(ev('ArrowUp', { alt: true })), 'type:leading-down');
  assert.equal(typeCommandFor(ev('ArrowUp', { alt: true, shift: true })), 'type:baseline-up');
  assert.equal(typeCommandFor(ev('ArrowLeft', { alt: true, ctrl: true })), 'type:kern-down-100');
  assert.equal(typeCommandFor(ev('+', { ctrl: true, shift: true }, 'Equal')), 'type:toggle-superscript');
  assert.equal(typeCommandFor(ev('h', { ctrl: true })), 'type:hide-selection');
  assert.equal(typeCommandFor(ev('l', { ctrl: true })), null);
  assert.equal(typeCommandFor(ev('ArrowUp', {})), null);
});

test('size, leading and baseline steps change every run of a range by the same amount', () => {
  let c = M.applyChar(M.fromPlain('abcd', { size: 20 }), 2, 4, { size: 30 });
  c = mapCharRuns(c, 1, 4, TYPE_COMMANDS['type:size-up'].run);
  assert.deepEqual(M.runsIn(c).map((r) => [r.to - r.from, r.style.size]), [[1, 20], [1, 22], [2, 32]]);
  c = mapCharRuns(c, 0, 4, TYPE_COMMANDS['type:size-down-10'].run);
  assert.deepEqual(M.runsIn(c).map((r) => r.style.size), [10, 12, 22]);
  // auto leading starts from the paragraph's auto leading (120 % of the size)
  assert.equal(leadingPx(M.resolveChar({ size: 20 })), 24);
  assert.equal(leadingPx(M.resolveChar({ size: 20, leading: 30 })), 30);
  const l = mapCharRuns(M.fromPlain('ab', { size: 20 }), 0, 2, TYPE_COMMANDS['type:leading-down'].run);
  assert.equal(M.charStyleAt(l, 0).leading, 22);
  const b = mapCharRuns(M.fromPlain('ab'), 0, 1, TYPE_COMMANDS['type:baseline-up-10'].run);
  assert.equal(M.charStyleAt(b, 0).baselineShift, 10);
  assert.equal(M.charStyleAt(b, 1).baselineShift, 0);
});

test('the kerning keys kern after the character before a caret and track a range', () => {
  const c = M.fromPlain('AVAV');
  const k = kernStep(c, 2, 2, 20);
  assert.equal(M.charStyleAt(k, 1).kern, 20);
  assert.equal(M.charStyleAt(k, 0).kern, 0);
  assert.equal(M.charStyleAt(kernStep(k, 2, 2, -100), 1).kern, -80);
  assert.equal(kernStep(c, 0, 0, 20), c); // nothing before the caret
  const t = kernStep(M.applyChar(c, 0, 2, { tracking: 50 }), 1, 3, -20);
  assert.deepEqual(M.runsIn(t).map((r) => [r.to - r.from, r.style.tracking]), [[1, 50], [1, 30], [1, -20], [1, 0]]);
});

test('toggles turn an attribute on unless the whole selection has it; paragraph commands', () => {
  const bold = TYPE_COMMANDS['type:toggle-faux-bold'].toggle;
  assert.deepEqual(bold({ fauxBold: false }), { fauxBold: true });
  assert.deepEqual(bold({ fauxBold: M.MIXED }), { fauxBold: true });
  assert.deepEqual(bold({ fauxBold: true }), { fauxBold: false });
  assert.deepEqual(TYPE_COMMANDS['type:toggle-small-caps'].toggle({ caps: 'all' }), { caps: 'small' });
  assert.deepEqual(TYPE_COMMANDS['type:toggle-small-caps'].toggle({ caps: 'small' }), { caps: 'normal' });
  assert.deepEqual(TYPE_COMMANDS['type:toggle-subscript'].toggle({ position: 'super' }), { position: 'sub' });
  assert.deepEqual(TYPE_COMMANDS['type:auto-leading'].toggle({}), { leading: 'auto' });
  assert.deepEqual(TYPE_COMMANDS['type:align-justify-all'].para({}), { align: 'justify-all' });
  assert.deepEqual(TYPE_COMMANDS['type:toggle-composer'].para({ composer: 'every' }), { composer: 'single' });
  assert.deepEqual(TYPE_COMMANDS['type:toggle-hyphenation'].para({ hyphenate: false }), { hyphenate: true });
});
