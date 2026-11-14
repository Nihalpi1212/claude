// Regressions from the 0.4 cross-feature hunt, area "type": PSD text keeping the 0.4 character attributes and the
// justified alignments on reopen, the arrow keys in vertical type, type commands outside a session as separate
// history steps, and a Type-tool click on a locked text layer starting new text.
import { test, expect } from '@playwright/test';
import { openApp, newDoc, runAwait, screenPoint } from './helpers.mjs';

/** Adds a text layer built from the rich-text model (one undoable 'Add' step) and makes it active. */
const addText = (page, spec) => page.evaluate(async (s) => {
  const app = window.pigmentApp;
  const { TextLayer } = await import('/lib/document.js');
  const { structural } = await import('/lib/layer-ops.js');
  const M = await import('/lib/type/model.js');
  const layer = new TextLayer({ content: M.fromPlain(s.text, s.char ?? { size: 30 }, s.para ?? {}), x: s.x ?? 20, y: s.y ?? 40, width: s.width ?? null });
  layer.name = s.name ?? s.text;
  structural(app, 'Add', () => {
    app.doc.add(layer);
    app.doc.setActive(layer);
  });
  return layer.id;
}, spec);

const labels = (page) => page.evaluate(() => {
  const h = window.pigmentApp.doc.history;
  return h.entries.slice(0, h.index + 1).map((e) => e.label);
});

/** The document point in the middle of character i of the named text layer. */
const charPoint = (page, name, i) => page.evaluate(async ([n, k]) => {
  const api = await import('/lib/type/api.js');
  const l = window.pigmentApp.doc.layers().find((x) => x.name === n);
  const a = api.caretRect(l, k), b = api.caretRect(l, k + 1);
  return [(a.x + b.x) / 2, a.y + a.height / 2];
}, [name, i]);

const clickDoc = async (page, x, y) => {
  const p = await screenPoint(page, x, y);
  await page.mouse.click(p.x, p.y);
};

test('PSD text reopens with strikethrough, caps, scale, baseline shift and justified alignment', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  await addText(page, { text: 'Strike caps', char: { size: 30, strike: true, caps: 'all', scaleX: 150, scaleY: 80, baselineShift: 5, tracking: 100, color: '#123456' }, name: 'A' });
  await addText(page, { text: 'Box para justified text here', char: { size: 20 }, para: { align: 'justify-all' }, y: 120, width: 200, name: 'B' });
  await page.evaluate(() => (window.__pigmentTest.nextSavePath = 'mem:/type.psd'));
  await runAwait(page, 'file:save-as');
  await expect.poll(() => page.evaluate(() => !!window.__pigmentTest.written['mem:/type.psd'])).toBe(true);
  await page.evaluate(() => (window.__pigmentTest.files['mem:/type2.psd'] = window.__pigmentTest.written['mem:/type.psd']));
  await runAwait(page, 'file:open-paths', ['mem:/type2.psd']);
  await expect.poll(() => page.evaluate(() => window.pigmentApp.doc?.path ?? null)).toBe('mem:/type2.psd');
  const back = await page.evaluate(async () => {
    const M = await import('/lib/type/model.js');
    const get = (n) => window.pigmentApp.doc.layers().find((l) => l.name === n);
    const a = get('A'), b = get('B');
    const ch = M.charStyleAt(a.content, 0);
    return {
      types: [a.type, b.type],
      a: { size: ch.size, strike: ch.strike, caps: ch.caps, scaleX: ch.scaleX, scaleY: ch.scaleY, baselineShift: ch.baselineShift, tracking: ch.tracking, color: ch.color },
      align: M.paragraphs(b.content)[0].style.align,
    };
  });
  expect(back.types).toEqual(['text', 'text']);
  expect(back.a).toEqual({ size: 30, strike: true, caps: 'all', scaleX: 150, scaleY: 80, baselineShift: 5, tracking: 100, color: '#123456' });
  expect(back.align).toBe('justify-all');
  expect(errors).toEqual([]);
});

test('arrow keys in vertical type move the caret the way the arrow points', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 400, height: 400 });
  await page.evaluate(() => window.pigmentApp.tools.activate('type-vertical'));
  await clickDoc(page, 200, 50);
  await expect.poll(() => page.evaluate(() => !!window.pigmentApp.tools.active.session)).toBe(true);
  await page.keyboard.type('ABCDE');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('FGHIJ');
  await expect.poll(() => page.evaluate(() => window.pigmentApp.tools.active.session.layer.text)).toBe('ABCDE FGHIJ');
  const from2 = async (key) => {
    await page.evaluate(() => window.pigmentApp.tools.active.session.editor.select(2));
    await page.keyboard.press(key);
    return page.evaluate(() => {
      const t = window.pigmentApp.tools.active.session.textarea;
      return [t.selectionStart, t.selectionEnd];
    });
  };
  // characters run down the column, columns step to the left
  expect(await from2('ArrowUp')).toEqual([1, 1]);
  expect(await from2('ArrowDown')).toEqual([3, 3]);
  expect(await from2('ArrowLeft')).toEqual([8, 8]); // the same place in the next column (to the left)
  expect(await from2('ArrowRight')).toEqual([0, 0]); // no column to the right: the start
  expect(await from2('Shift+ArrowDown')).toEqual([2, 3]);
  expect(errors).toEqual([]);
});

test('type commands outside a session are one history step each', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  await addText(page, { text: 'Merge test', char: { size: 30 }, y: 60 });
  await page.evaluate(() => window.pigmentApp.tools.activate('move'));
  const runs = () => page.evaluate(() => window.pigmentApp.doc.active.content.runs.map((r) => [r.style.size, !!r.style.fauxBold, !!r.style.underline]));
  await runAwait(page, 'type:size-up');
  await runAwait(page, 'type:size-up'); // a repeat of the same command still merges
  await runAwait(page, 'type:toggle-faux-bold');
  await runAwait(page, 'type:toggle-underline');
  expect((await labels(page)).slice(-4)).toEqual(['Add', 'Font Size', 'Faux Bold', 'Underline']);
  expect(await runs(page)).toEqual([[34, true, true]]);
  await page.evaluate(() => window.pigmentApp.doc.history.undo());
  expect(await runs(page)).toEqual([[34, true, false]]);
  await page.evaluate(() => window.pigmentApp.doc.history.undo());
  expect(await runs(page)).toEqual([[34, false, false]]);
  await page.evaluate(() => window.pigmentApp.doc.history.undo());
  expect(await runs(page)).toEqual([[30, false, false]]);
  expect(errors).toEqual([]);
});

test('a Type-tool click on a locked text layer starts new text, and typing does not run shortcuts', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  await addText(page, { text: 'Locked text', name: 'Locked' });
  await page.evaluate(() => {
    const d = window.pigmentApp.doc;
    const l = d.layers().find((x) => x.name === 'Locked');
    l.locked = { ...l.locked, all: true };
    d.changed('props', {});
  });
  await page.evaluate(() => window.pigmentApp.tools.activate('type-horizontal'));
  await clickDoc(page, ...(await charPoint(page, 'Locked', 3)));
  await expect.poll(() => page.evaluate(() => window.pigmentApp.tools.active.session?.isNew ?? null)).toBe(true);
  await page.keyboard.type('Q');
  await expect.poll(() => page.evaluate(() => window.pigmentApp.tools.active.session?.layer.text ?? null)).toBe('Q');
  const state = await page.evaluate(() => ({
    tool: window.pigmentApp.tools.active.id,
    layers: window.pigmentApp.doc.layers().map((l) => l.name),
    locked: window.pigmentApp.doc.layers().find((x) => x.name === 'Locked').text,
  }));
  expect(state.tool).toBe('type-horizontal');
  expect(state.layers).not.toContain('Quick Mask');
  expect(state.locked).toBe('Locked text');
  expect(errors).toEqual([]);
});
