// type-editing (0.4, package 2): the Type tool editor on the rich-text model (ARCHITECTURE.md "0.4 features", B.7,
// B.8, M.4 TYPE_KEYS). Runs on the stub engine ('canvas'): the browser build has no installed font for HarfBuzz.
import { test, expect } from '@playwright/test';
import { openApp, newDoc, run, runAwait, screenPoint, drag, historyLength, confirmDialog } from './helpers.mjs';

const activate = (page, id) => page.evaluate((t) => window.pigmentApp.tools.activate(t), id);
const click = async (page, x, y, opts) => {
  const a = await screenPoint(page, x, y);
  await page.mouse.click(a.x, a.y, opts);
};
const editing = (page) => page.evaluate(() => /^type-/.test(window.pigmentApp.tools.active?.id ?? '') && !!window.pigmentApp.tools.active.session);
/** The open session: text, selection (from the hidden input, B.8) and the runs as [length, colour, fauxBold]. */
const state = (page) =>
  page.evaluate(() => {
    const s = window.pigmentApp.tools.active?.session;
    if (!s) return null;
    const l = s.layer;
    return { text: l.text, sel: [s.textarea.selectionStart, s.textarea.selectionEnd], runs: l.content.runs.map((r) => [r.len, r.style.color ?? null, !!r.style.fauxBold]) };
  });
/** The document point at the middle of character i of the active (or editing) text layer. */
const charPoint = (page, i) =>
  page.evaluate(async (k) => {
    const api = await import('/lib/type/api.js');
    const app = window.pigmentApp;
    const l = app.tools.active?.session?.layer ?? app.doc.active;
    const a = api.caretRect(l, k), b = api.caretRect(l, k + 1);
    const x = b.line === a.line ? (a.x + b.x) / 2 : a.x + 4;
    return [x, a.y + a.height / 2];
  }, i);
/** Adds a text layer from model content built in the page: spec = { text, char, x, y, width, height, runs: [[from, to, patch]] }. */
const addText = (page, spec) =>
  page.evaluate(async (s) => {
    const app = window.pigmentApp;
    const { TextLayer } = await import('/lib/document.js');
    const { structural } = await import('/lib/layer-ops.js');
    const M = await import('/lib/type/model.js');
    let content = M.fromPlain(s.text, s.char ?? { size: 40 });
    for (const [a, b, patch] of s.runs ?? []) content = M.applyChar(content, a, b, patch);
    const layer = new TextLayer({ content, x: s.x ?? 20, y: s.y ?? 40, width: s.width ?? null });
    if (s.height) layer.height = s.height;
    layer.name = s.name ?? s.text.slice(0, 20);
    structural(app, 'Add', () => {
      app.doc.add(layer);
      app.doc.setActive(layer);
    });
    return layer.id;
  }, spec);
const editLayer = async (page, id) => {
  await runAwait(page, 'layer:edit-text', id);
  await expect.poll(() => editing(page)).toBe(true);
};
const selectRange = (page, a, b) => page.evaluate(([x, y]) => window.pigmentApp.tools.active.session.editor.select(x, y), [a, b]);

test('typing replaces the placeholder; a double-click selects a word; bold through the type target; Edit > Undo and Ctrl+Z step inside the session; the commit is one entry', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  await activate(page, 'type-horizontal');
  const before = await historyLength(page);
  await click(page, 50, 100);
  await expect.poll(() => state(page)).toMatchObject({ text: 'Lorem Ipsum', sel: [0, 11] });
  await page.keyboard.type('Hello big world');
  expect((await state(page)).text).toBe('Hello big world');
  expect(await page.evaluate(() => window.pigmentApp.doc.active.name)).toBe('Hello big world');
  // the word "big" by double-click
  const [x, y] = await charPoint(page, 7);
  await click(page, x, y, { clickCount: 2 });
  await expect.poll(() => state(page).then((s) => s.sel)).toEqual([6, 9]);
  await page.evaluate(async () => {
    const t = await import('/lib/type/target.js');
    t.applyChar(window.pigmentApp, { fauxBold: true });
  });
  expect((await state(page)).runs).toEqual([[6, null, false], [3, null, true], [6, null, false]]);
  // Edit > Undo (the command) and Ctrl+Z undo the bold inside the session; redo brings it back
  await runAwait(page, 'edit:undo');
  expect(await editing(page)).toBe(true);
  expect((await state(page)).runs).toEqual([[15, null, false]]);
  await runAwait(page, 'edit:redo');
  expect((await state(page)).runs).toEqual([[6, null, false], [3, null, true], [6, null, false]]);
  await page.keyboard.press('Control+z');
  expect((await state(page)).runs).toEqual([[15, null, false]]);
  await page.keyboard.press('Control+Shift+z');
  expect((await state(page)).runs).toEqual([[6, null, false], [3, null, true], [6, null, false]]);
  expect(await historyLength(page)).toBe(before + 1); // the new layer's entry only, while editing
  await page.keyboard.press('Control+Enter');
  expect(await editing(page)).toBe(false);
  expect(await historyLength(page)).toBe(before + 1); // creating and typing: one entry
  expect(await page.evaluate(() => window.pigmentApp.doc.active.content.runs.map((r) => [r.len, !!r.style.fauxBold]))).toEqual([[6, false], [3, true], [6, false]]);
  // editing an existing layer is one more entry
  await click(page, x, y);
  await expect.poll(() => editing(page)).toBe(true);
  await page.keyboard.press('End');
  await page.keyboard.type('!');
  await page.keyboard.press('Control+Enter');
  expect(await historyLength(page)).toBe(before + 2);
  expect(await page.evaluate(() => window.pigmentApp.doc.active.text)).toBe('Hello big world!');
  await runAwait(page, 'edit:undo');
  expect(await page.evaluate(() => window.pigmentApp.doc.active.content.runs.map((r) => [r.len, !!r.style.fauxBold]))).toEqual([[6, false], [3, true], [6, false]]);
  await runAwait(page, 'edit:undo');
  expect(await page.evaluate(() => window.pigmentApp.doc.layers().filter((l) => l.type === 'text').length)).toBe(0);
  expect(errors).toEqual([]);
});

test('selection levels: triple-click a line, four clicks a paragraph, five the whole text; Ctrl+A; keys move and extend; Tab and Shift+Enter type', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  const id = await addText(page, { text: 'Hello world\nSecond para here', width: 150, x: 20, y: 20 });
  await editLayer(page, id);
  expect((await state(page)).sel).toEqual([0, 28]); // Edit Text selects everything
  const [x, y] = await charPoint(page, 20); // in "para " (the fourth laid-out line)
  await click(page, x, y);
  await expect.poll(() => state(page).then((s) => s.sel)).toEqual([20, 20]);
  await page.waitForTimeout(600);
  await click(page, x, y, { clickCount: 3 });
  await expect.poll(() => state(page).then((s) => s.sel)).toEqual([19, 24]);
  await page.waitForTimeout(600);
  await click(page, x, y, { clickCount: 4 });
  await expect.poll(() => state(page).then((s) => s.sel)).toEqual([12, 28]);
  await page.waitForTimeout(600);
  await click(page, x, y, { clickCount: 5 });
  await expect.poll(() => state(page).then((s) => s.sel)).toEqual([0, 28]);
  // keys: Home / End on the laid-out line, Shift extends, Ctrl+A selects all
  await page.keyboard.press('ArrowLeft');
  expect((await state(page)).sel).toEqual([0, 0]);
  await page.keyboard.press('End');
  expect((await state(page)).sel).toEqual([6, 6]); // after "Hello " (a soft wrap)
  // down from the end of "Hello " lands at the end of the shorter "world" below
  await page.keyboard.press('Shift+ArrowDown');
  expect((await state(page)).sel).toEqual([6, 11]);
  await page.keyboard.press('Shift+ArrowDown');
  expect((await state(page)).sel[1]).toBeGreaterThan(12);
  await page.keyboard.press('Control+End');
  expect((await state(page)).sel).toEqual([28, 28]);
  await page.keyboard.press('Shift+Home');
  expect((await state(page)).sel).toEqual([24, 28]);
  await page.keyboard.press('Control+a');
  expect((await state(page)).sel).toEqual([0, 28]);
  await page.keyboard.press('Control+Home');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Shift+Enter');
  expect((await state(page)).text).toBe('\t\u2028Hello world\nSecond para here');
  await page.keyboard.press('Escape');
  expect(await page.evaluate(() => window.pigmentApp.doc.active.text)).toBe('Hello world\nSecond para here');
  expect(errors).toEqual([]);
});

test('copy two runs, paste them into another layer with both formats; another copied text pastes plain; Paste Without Formatting from the command', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 500, height: 300 });
  const a = await addText(page, { text: 'Hello World', char: { size: 40, color: '#ff0000' }, runs: [[6, 11, { color: '#0000ff', underline: true }]], x: 20, y: 20 });
  const b = await addText(page, { text: 'XY', char: { size: 20, color: '#00ff00' }, x: 20, y: 200 });
  await editLayer(page, a);
  await selectRange(page, 3, 9);
  await page.keyboard.press('Control+c');
  expect(await page.evaluate(() => window.__pigmentTest.clipboardText)).toBe('lo Wor');
  await page.keyboard.press('Control+Enter');
  await editLayer(page, b);
  await selectRange(page, 1, 1);
  await page.keyboard.press('Control+v');
  await expect.poll(() => state(page).then((s) => s.text)).toBe('Xlo WorY');
  const runs = () => page.evaluate(() => window.pigmentApp.tools.active.session.layer.content.runs.map((r) => [r.len, r.style.color ?? null, r.style.size ?? 48, !!r.style.underline]));
  expect(await runs()).toEqual([[1, '#00ff00', 20, false], [3, '#ff0000', 40, false], [3, '#0000ff', 40, true], [1, '#00ff00', 20, false]]);
  expect((await state(page)).sel).toEqual([7, 7]);
  // the system clipboard changed since (another application copied): its text, in the style at the caret
  await page.evaluate(() => (window.__pigmentTest.clipboardText = 'plain'));
  await selectRange(page, 0, 0);
  await page.keyboard.press('Control+v');
  await expect.poll(() => state(page).then((s) => s.text)).toBe('plainXlo WorY');
  expect((await runs())[0]).toEqual([6, '#00ff00', 20, false]);
  // Paste Without Formatting (Edit > Paste Special) drops the formatting even while the in-app clipboard is current
  await page.evaluate(() => (window.__pigmentTest.clipboardText = 'lo Wor'));
  await selectRange(page, 13, 13);
  await runAwait(page, 'edit:paste-without-formatting');
  expect((await state(page)).text).toBe('plainXlo WorYlo Wor');
  expect((await runs()).at(-1)).toEqual([7, '#00ff00', 20, false]);
  // cut through the command, then undo it inside the session
  await selectRange(page, 0, 5);
  await runAwait(page, 'edit:cut');
  expect((await state(page)).text).toBe('Xlo WorYlo Wor');
  expect(await page.evaluate(() => window.__pigmentTest.clipboardText)).toBe('plain');
  await runAwait(page, 'edit:undo');
  expect((await state(page)).text).toBe('plainXlo WorYlo Wor');
  await page.keyboard.press('Control+Enter');
  // outside a session the menu item is disabled
  expect(await page.evaluate(() => window.pigmentApp.commands.isEnabled('edit:paste-without-formatting'))).toBe(false);
  expect(errors).toEqual([]);
});

test('IME composition (CompositionEvent): the composed text is laid out underlined and lands as one undo step', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  const id = await addText(page, { text: 'ab', x: 20, y: 40 });
  await editLayer(page, id);
  await selectRange(page, 1, 1);
  // what a Japanese IME sends: compositionstart, updates with the text so far (the input's value changes with them),
  // compositionend with the chosen text
  const r = await page.evaluate(async () => {
    const app = window.pigmentApp;
    const ed = app.tools.active.session.editor;
    const ta = ed.input;
    const step = (value, caret, data, composing) => {
      ta.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertCompositionText', data, isComposing: composing, bubbles: true, cancelable: true }));
      ta.value = value;
      ta.setSelectionRange(caret, caret);
      ta.dispatchEvent(new CompositionEvent('compositionupdate', { data }));
      ta.dispatchEvent(new InputEvent('input', { inputType: 'insertCompositionText', data, isComposing: composing, bubbles: true }));
    };
    ta.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
    step('aにb', 2, 'に', true);
    step('aにほb', 3, 'にほ', true);
    const mid = { text: ed.layer.text, composing: ed.composing && [ed.composing.from, ed.composing.to] };
    step('a日本b', 3, '日本', true);
    ta.dispatchEvent(new CompositionEvent('compositionend', { data: '日本' }));
    const done = { text: ed.layer.text, composing: ed.composing, sel: [ta.selectionStart, ta.selectionEnd] };
    await app.commands.run('edit:undo', undefined, 'api');
    return { mid, done, undone: ed.layer.text };
  });
  expect(r.mid).toEqual({ text: 'aにほb', composing: [1, 3] });
  expect(r.done).toEqual({ text: 'a日本b', composing: null, sel: [3, 3] });
  expect(r.undone).toBe('ab'); // the whole composition is one step
  expect(errors).toEqual([]);
});

test('IME through the browser (CDP Input.imeSetComposition) composes into the layer', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  const id = await addText(page, { text: 'ab', x: 20, y: 40 });
  await editLayer(page, id);
  await selectRange(page, 2, 2);
  let cdp;
  try {
    cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.imeSetComposition', { text: 'ñ', selectionStart: 1, selectionEnd: 1 });
  } catch {
    test.skip(true, 'no CDP IME in this browser');
  }
  await expect.poll(() => page.evaluate(() => window.pigmentApp.tools.active.session.layer.text)).toBe('abñ');
  expect(await page.evaluate(() => !!window.pigmentApp.tools.active.session.editor.composing)).toBe(true);
  await cdp.send('Input.insertText', { text: 'ñ' });
  await expect.poll(() => page.evaluate(() => !!window.pigmentApp.tools.active.session.editor.composing)).toBe(false);
  expect((await state(page)).text).toBe('abñ');
  await page.keyboard.type('c');
  expect((await state(page)).text).toBe('abñc');
  expect(errors).toEqual([]);
});

test('double-clicking text with the Move tool starts editing at the click', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  // the Move tool picks the layer by its pixels: the middle of an "I" is ink
  await addText(page, { text: 'IIIIII', char: { size: 80, fauxBold: true }, x: 40, y: 60 });
  await activate(page, 'move');
  const [x, y] = await charPoint(page, 2);
  await click(page, x, y, { clickCount: 2 });
  await expect.poll(() => page.evaluate(() => window.pigmentApp.tools.active.id)).toBe('type-horizontal');
  await expect.poll(() => editing(page)).toBe(true);
  const s = await state(page);
  expect(s.sel[0]).toBe(s.sel[1]);
  expect(s.sel[0]).toBeGreaterThanOrEqual(2);
  expect(s.sel[0]).toBeLessThanOrEqual(3);
  expect(errors).toEqual([]);
});

test('box handles change the width and the height; a dragged box keeps its height and shows overflow', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  await activate(page, 'type-horizontal');
  await drag(page, [100, 50], [300, 200]);
  await expect.poll(() => editing(page)).toBe(true);
  const box = () => page.evaluate(() => {
    const l = window.pigmentApp.tools.active.session?.layer ?? window.pigmentApp.doc.active;
    return { x: l.x, y: l.y, width: l.width, height: l.height, overflow: l.layout().overflow };
  });
  // the placeholder fills the box and overflows it
  expect(await box()).toEqual({ x: 100, y: 50, width: 200, height: 150, overflow: true });
  await page.keyboard.type('Short');
  expect((await box()).overflow).toBe(false);
  // the bottom edge's middle handle sets the height, the right one the width
  await drag(page, [200, 200], [200, 120]);
  expect(await box()).toMatchObject({ width: 200, height: 70 });
  await drag(page, [300, 85], [250, 85]);
  expect(await box()).toMatchObject({ width: 150, height: 70 });
  // the top-left corner moves the box's origin
  await drag(page, [100, 50], [110, 60]);
  expect(await box()).toMatchObject({ x: 110, y: 60, width: 140, height: 60 });
  // a handle drag is one step of the session's undo
  await runAwait(page, 'edit:undo');
  expect(await box()).toMatchObject({ x: 100, y: 50, width: 150, height: 70 });
  await page.keyboard.press('Control+Enter');
  expect(await box()).toMatchObject({ x: 100, y: 50, width: 150, height: 70, overflow: false });
  expect(errors).toEqual([]);
});

test('TYPE_KEYS change size, alignment, kerning and the toggles while editing; outside a session the commands act on the layer', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  const id = await addText(page, { text: 'Hello', char: { size: 40 }, x: 40, y: 60 });
  await editLayer(page, id);
  const attrs = () => page.evaluate(() => {
    const l = window.pigmentApp.tools.active?.session?.layer ?? window.pigmentApp.doc.active;
    const r = l.content.runs.map((x) => x.style);
    return { size: r.map((s) => s.size ?? 48), align: l.content.paras[0].style.align ?? 'left', bold: r.map((s) => !!s.fauxBold), kern: r.map((s) => s.kern ?? 0), caps: r.map((s) => s.caps ?? 'normal') };
  });
  await page.keyboard.press('Control+Shift+Period');
  expect((await attrs()).size).toEqual([42]);
  await page.keyboard.press('Control+Alt+Shift+Period');
  expect((await attrs()).size).toEqual([52]);
  await page.keyboard.press('Control+Shift+Comma');
  expect((await attrs()).size).toEqual([50]);
  await page.keyboard.press('Control+Shift+c');
  expect((await attrs()).align).toBe('center');
  await page.keyboard.press('Control+Shift+r');
  expect((await attrs()).align).toBe('right');
  await page.keyboard.press('Control+Shift+b');
  expect((await attrs()).bold).toEqual([true]);
  await page.keyboard.press('Control+Shift+k');
  expect((await attrs()).caps).toEqual(['all']);
  // Ctrl+H hides the selection highlight (and shows it again)
  await page.keyboard.press('Control+h');
  expect(await page.evaluate(() => window.pigmentApp.tools.active.session.editor.hideSelection)).toBe(true);
  await page.keyboard.press('Control+h');
  // Alt+Right at a caret kerns the pair around it
  await selectRange(page, 2, 2);
  await page.keyboard.press('Alt+ArrowRight');
  await page.keyboard.press('Alt+ArrowRight');
  expect((await attrs()).kern).toEqual([0, 40, 0]);
  await page.keyboard.press('Control+Enter');
  // not editing: the command changes the targeted layer as one entry
  const n = await historyLength(page);
  await runAwait(page, 'type:size-down');
  expect((await attrs()).size).toEqual([48, 48, 48]);
  expect(await historyLength(page)).toBe(n + 1);
  await runAwait(page, 'type:align-left');
  expect((await attrs()).align).toBe('left');
  expect(await page.evaluate(() => window.pigmentApp.commands.isEnabled('type:hide-selection'))).toBe(false);
  expect(errors).toEqual([]);
});

test('Shift+Ctrl+L while editing aligns left and records no Auto Tone; the menu copy of the key is swallowed', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  const id = await addText(page, { text: 'Centered', x: 40, y: 60 });
  await page.evaluate(async (lid) => {
    const t = await import('/lib/type/target.js');
    const app = window.pigmentApp;
    app.doc.setActive(app.doc.find(lid));
    t.applyPara(app, { align: 'center' });
  }, id);
  await page.evaluate(() => {
    const app = window.pigmentApp;
    window.__seen = [];
    app.commands.observe({ before: (cmd, arg, source) => ({ cmd, source }), after: (t, r, i) => window.__seen.push([t.cmd, t.source, i.handledBy]) });
    const engine = app.actions;
    const action = engine.newAction({ name: 'Typing', steps: [] });
    engine.record(engine.sets.flatMap((s) => s.actions).find((a) => a.id === action.id || a.id === action));
  });
  await expect.poll(() => page.evaluate(() => !!window.pigmentApp.actions.recording)).toBe(true);
  await editLayer(page, id);
  const align = () => page.evaluate(() => window.pigmentApp.tools.active.session.layer.content.paras[0].style.align ?? 'left');
  await page.keyboard.press('Control+Shift+l');
  expect(await align()).toBe('left');
  // Windows and Linux also deliver the accelerator to the native menu: its copy within 40 ms is swallowed
  const swallowed = await page.evaluate(() => {
    const app = window.pigmentApp;
    const ed = app.tools.active.session.editor;
    ed.ran.set('type:align-left', performance.now());
    app.commands.run('image:auto-tone', undefined, 'menu-key');
    return window.__seen.filter(([c]) => c === 'image:auto-tone');
  });
  expect(swallowed).toEqual([['image:auto-tone', 'menu-key', 'type']]);
  // macOS: the menu takes the key before the page; the session runs the type command instead of Auto Tone
  await page.evaluate(async () => {
    const t = await import('/lib/type/target.js');
    t.applyPara(window.pigmentApp, { align: 'right' });
  });
  await page.waitForTimeout(60);
  await page.evaluate(() => window.pigmentApp.commands.run('image:auto-tone', undefined, 'menu-key'));
  expect(await align()).toBe('left');
  expect(await editing(page)).toBe(true);
  await page.keyboard.press('Control+Enter');
  const steps = await page.evaluate(() => {
    const engine = window.pigmentApp.actions;
    const a = engine.recording.action;
    engine.stopRecording();
    return a.steps.map((s) => s.command);
  });
  expect(steps).not.toContain('image:auto-tone');
  expect(errors).toEqual([]);
});

test('a command clicked in the menu (source menu) commits the text first; Edit > Undo from the menu stays in the session', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  const id = await addText(page, { text: 'Menu', x: 40, y: 60 });
  await editLayer(page, id);
  await page.keyboard.press('End');
  await page.keyboard.type('s');
  await page.evaluate(() => window.pigmentApp.commands.run('edit:undo', undefined, 'menu'));
  expect(await editing(page)).toBe(true);
  expect((await state(page)).text).toBe('Menu');
  await page.keyboard.type('x');
  const n = await historyLength(page);
  await page.evaluate(() => window.pigmentApp.commands.run('layer:new', undefined, 'menu'));
  await expect.poll(() => editing(page)).toBe(false);
  expect(await page.evaluate(() => window.pigmentApp.doc.layers().find((l) => l.type === 'text').text)).toBe('Menux');
  expect(await historyLength(page)).toBeGreaterThanOrEqual(n + 1);
  expect(errors).toEqual([]);
});

test('Ctrl-drag and a drag outside the text move it while editing; a click outside commits', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  const id = await addText(page, { text: 'Move me', x: 40, y: 60 });
  await editLayer(page, id);
  const pos = () => page.evaluate(() => {
    const l = window.pigmentApp.doc.find(window.__id);
    return [l.x, l.y];
  });
  await page.evaluate((lid) => (window.__id = lid), id);
  const [x, y] = await charPoint(page, 2);
  await drag(page, [x, y], [x + 30, y + 20], { modifiers: ['Control'] });
  expect(await pos()).toEqual([70, 80]);
  expect(await editing(page)).toBe(true);
  expect((await state(page)).text).toBe('Move me');
  await drag(page, [350, 250], [340, 240]);
  expect(await pos()).toEqual([60, 70]);
  expect(await editing(page)).toBe(true);
  await runAwait(page, 'edit:undo'); // one step per move
  expect(await pos()).toEqual([70, 80]);
  await click(page, 350, 250);
  await expect.poll(() => editing(page)).toBe(false);
  expect(await pos()).toEqual([70, 80]);
  await runAwait(page, 'edit:undo');
  expect(await pos()).toEqual([40, 60]);
  expect(errors).toEqual([]);
});

test('Ctrl/Cmd shows the transform box: dragging its corner scales the text through Free Transform, then editing goes on', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  const id = await addText(page, { text: 'Scale', x: 40, y: 60 });
  await editLayer(page, id);
  await selectRange(page, 1, 3);
  const b = await page.evaluate((lid) => window.pigmentApp.doc.find(lid).bounds(), id);
  await page.keyboard.down('Control');
  expect(await page.evaluate(() => window.pigmentApp.tools.active.session.editor.ctrlHeld)).toBe(true);
  const from = await screenPoint(page, b.x + b.width, b.y + b.height);
  const to = await screenPoint(page, b.x + b.width * 2, b.y + b.height * 2);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.up('Control');
  await expect.poll(() => editing(page)).toBe(true);
  const r = await page.evaluate((lid) => {
    const app = window.pigmentApp;
    const l = app.doc.find(lid);
    return { t: l.transform, tool: app.tools.active.id, layer: app.tools.active.session.layer === l, sel: [app.tools.active.session.textarea.selectionStart, app.tools.active.session.textarea.selectionEnd], tt: !!app.transformTool.session };
  }, id);
  expect(r.tool).toBe('type-horizontal');
  expect(r.layer).toBe(true);
  expect(r.tt).toBe(false);
  expect(r.sel).toEqual([1, 3]);
  expect(r.t).not.toBeNull();
  expect(r.t[0]).toBeGreaterThan(1.5);
  await page.keyboard.press('Escape');
  expect(errors).toEqual([]);
});

test('Alt-click asks for the paragraph box size; the placeholder fills it; Preferences turn the placeholder off', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  await activate(page, 'type-horizontal');
  const a = await screenPoint(page, 60, 40);
  await page.keyboard.down('Alt');
  await page.mouse.click(a.x, a.y);
  await page.keyboard.up('Alt');
  const dialog = page.locator('.dialog');
  await expect(dialog).toContainText('Paragraph Text Size');
  await dialog.locator('input[data-key="width"]').fill('220');
  await dialog.locator('input[data-key="height"]').fill('80');
  await confirmDialog(page);
  await expect.poll(() => editing(page)).toBe(true);
  const s = await page.evaluate(() => {
    const l = window.pigmentApp.tools.active.session.layer;
    return { x: l.x, y: l.y, width: l.width, height: l.height, words: l.text.split(' ').length, sel: [window.pigmentApp.tools.active.session.textarea.selectionStart, window.pigmentApp.tools.active.session.textarea.selectionEnd], len: l.text.length };
  });
  expect(s).toMatchObject({ x: 60, y: 40, width: 220, height: 80 });
  expect(s.words).toBeGreaterThan(20);
  expect(s.sel).toEqual([0, s.len]);
  await page.keyboard.press('Escape');
  expect(await page.evaluate(() => window.pigmentApp.doc.layers().filter((l) => l.type === 'text').length)).toBe(0);
  // the Preferences section writes settings.type.placeholder
  const pref = await page.evaluate(() => {
    const sec = window.pigmentApp.preferences.sections().find((x) => x.id === 'type');
    return { title: sec.title, read: sec.read(window.pigmentApp.settings), write: sec.write({ typePlaceholder: false }, window.pigmentApp.settings) };
  });
  expect(pref.title).toBe('Type');
  expect(pref.read).toEqual({ typePlaceholder: true });
  expect(pref.write.type.placeholder).toBe(false);
  await page.evaluate((patch) => window.pigmentApp.saveSettings(patch), pref.write);
  await click(page, 60, 200);
  await expect.poll(() => editing(page)).toBe(true);
  expect((await state(page)).text).toBe('');
  await page.keyboard.press('Escape');
  expect(errors).toEqual([]);
});

test('the editor works the same on the HarfBuzz engine: the caret stops inside a ligature, a double-click selects a word, typing reflows', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  // the OFL test font of type-engine-core, under a family no system has, so HarfBuzz lays the text out
  await page.evaluate(async () => {
    const bytes = new Uint8Array(await (await fetch('/fixtures/fonts/Carlito-Regular.ttf')).arrayBuffer());
    return window.__pigmentTest.addFont(bytes, { family: 'Pigment Edit Carlito' });
  });
  const id = await addText(page, { text: 'office files', char: { fontFamily: 'Pigment Edit Carlito', size: 48 }, x: 20, y: 40 });
  expect(await page.evaluate(async (lid) => (await import('/lib/type/api.js')).currentEngine(window.pigmentApp.doc.find(lid)).id, id)).toBe('harfbuzz');
  await editLayer(page, id);
  // "ffi" is one glyph; the caret still stands between its letters, at increasing x
  const xs = await page.evaluate(async (lid) => {
    const api = await import('/lib/type/api.js');
    const l = window.pigmentApp.doc.find(lid);
    return [1, 2, 3, 4].map((i) => api.caretRect(l, i).x);
  }, id);
  for (let i = 1; i < xs.length; i++) expect(xs[i]).toBeGreaterThan(xs[i - 1]);
  await page.keyboard.press('Control+Home');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  expect((await state(page)).sel).toEqual([2, 2]);
  const [x, y] = await charPoint(page, 9);
  await click(page, x, y, { clickCount: 2 });
  await expect.poll(() => state(page).then((s) => s.sel)).toEqual([7, 12]);
  await page.keyboard.type('fig');
  expect((await state(page)).text).toBe('office fig');
  expect(await page.evaluate((lid) => window.pigmentApp.doc.find(lid).layout().engine, id)).toBe('harfbuzz');
  await page.keyboard.press('Control+Enter');
  expect(errors).toEqual([]);
});
