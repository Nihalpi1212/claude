// type-character-panel (0.4, package 3): the Character panel and the Properties text section on the range model
// (ARCHITECTURE.md "0.4 features", B.7, H, L.1, L.14): units, mixed values, ranges, several layers, Reset Character,
// the options bar's font size and optical kerning. Most tests run on the stub engine ('canvas'); the optical kerning
// test loads the OFL test font so HarfBuzz and its outlines run.
import { test, expect } from '@playwright/test';
import { openApp, newDoc, runAwait, historyLength } from './helpers.mjs';

const panel = (page) => page.locator('.panel.char-panel');
const field = (page, k) => panel(page).locator(`input[data-key="${k}"]`);
const selectK = (page, k) => panel(page).locator(`select[data-k="${k}"]`);
const toggle = (page, k) => panel(page).locator(`.char-toggle[data-k="${k}"]`);

/** Adds a text layer from model content: spec = { text, char, x, y, width, runs: [[from, to, patch]], select }. */
const addText = (page, spec) =>
  page.evaluate(async (s) => {
    const app = window.pigmentApp;
    const { TextLayer } = await import('/lib/document.js');
    const { structural } = await import('/lib/layer-ops.js');
    const M = await import('/lib/type/model.js');
    let content = M.fromPlain(s.text, s.char ?? { size: 40 });
    for (const [a, b, patch] of s.runs ?? []) content = M.applyChar(content, a, b, patch);
    const layer = new TextLayer({ content, x: s.x ?? 20, y: s.y ?? 40, width: s.width ?? null });
    layer.name = s.name ?? s.text.slice(0, 20);
    structural(app, 'Add', () => {
      app.doc.add(layer);
      app.doc.setActive(layer);
    });
    return layer.id;
  }, spec);
/** Runs of a layer as [length, patch of the keys asked for]. */
const runs = (page, id, keys) =>
  page.evaluate(([lid, ks]) => {
    const l = window.pigmentApp.doc.find(lid);
    return l.content.runs.map((r) => [r.len, Object.fromEntries(ks.map((k) => [k, r.style[k] ?? null]))]);
  }, [id, keys]);
const charAt = (page, id, i) =>
  page.evaluate(async ([lid, k]) => {
    const M = await import('/lib/type/model.js');
    return M.charStyleAt(window.pigmentApp.doc.find(lid).content, k);
  }, [id, i]);
const showPanel = async (page) => {
  await runAwait(page, 'window:panel-character');
  await expect(panel(page)).toBeVisible();
};
const setUnit = (page, unit) => page.evaluate((u) => window.pigmentApp.saveSettings({ type: { ...window.pigmentApp.settings.type, unit: u } }), unit);
const editLayer = async (page, id) => {
  await runAwait(page, 'layer:edit-text', id);
  await expect.poll(() => page.evaluate(() => !!window.pigmentApp.tools.active?.session)).toBe(true);
};
const selectRange = (page, a, b) => page.evaluate(([x, y]) => window.pigmentApp.tools.active.session.editor.select(x, y), [a, b]);
/** Types into a numeric field and commits it as Enter / blur would (a change event). */
const fillField = async (locator, value) => {
  await locator.fill(String(value));
  await locator.press('Enter');
};

test('size in pt at 300 ppi stores px; the panel and the options bar show the unit; presets', async ({ page }) => {
  const errors = await openApp(page);
  await setUnit(page, 'pt');
  await newDoc(page, { width: 600, height: 300, dpi: 300 });
  const id = await addText(page, { text: 'Units', char: { size: 40 } });
  await showPanel(page);
  // 40 px at 300 ppi is 9.6 pt
  await expect(field(page, 'size')).toHaveValue('9.6');
  await expect(panel(page).locator('[data-row="size"] .opt-unit')).toHaveText('pt');
  const before = await historyLength(page);
  await fillField(field(page, 'size'), 12);
  await expect.poll(() => charAt(page, id, 0).then((s) => s.size)).toBe(50);
  expect(await historyLength(page)).toBe(before + 1);
  // the size list: 24 pt is 100 px at 300 ppi
  await panel(page).locator('select[data-k="sizePresets"]').selectOption({ label: '24 pt' });
  await expect.poll(() => charAt(page, id, 0).then((s) => s.size)).toBe(100);
  await expect(field(page, 'size')).toHaveValue('24');

  // the options bar's font-size field (kind font-size): the same unit, its own preset list
  await page.evaluate(() => window.pigmentApp.tools.activate('type-horizontal'));
  const bar = page.locator('#options-bar .char-size-field');
  await expect(bar.locator('.opt-unit')).toHaveText('pt');
  await expect(bar.locator('input')).toHaveValue('24');
  await bar.locator('select').selectOption({ label: '36 pt' });
  await expect.poll(() => charAt(page, id, 0).then((s) => s.size)).toBe(150);
  await bar.locator('input').fill('6');
  await bar.locator('input').dispatchEvent('change');
  await expect.poll(() => charAt(page, id, 0).then((s) => s.size)).toBe(25);

  // millimetres: 25 px at 300 ppi is 2.12 mm
  await setUnit(page, 'mm');
  await expect(field(page, 'size')).toHaveValue('2.12');
  await expect(panel(page).locator('[data-row="size"] .opt-unit')).toHaveText('mm');
  await expect(bar.locator('.opt-unit').first()).toHaveText('mm');
  expect(errors).toEqual([]);
});

test('a range made bold keeps the rest regular, also after typing one more character', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  const id = await addText(page, { text: 'Hello world', char: { size: 40 } });
  await showPanel(page);
  await editLayer(page, id);
  await selectRange(page, 0, 5);
  await selectK(page, 'style').selectOption('700');
  await toggle(page, 'faux-italic').click();
  await expect.poll(() => runs(page, id, ['fontWeight', 'fauxItalic'])).toEqual([[5, { fontWeight: 700, fauxItalic: true }], [6, { fontWeight: null, fauxItalic: null }]]);
  // mixed over the whole text: the style select is blank and the toggle shows mixed
  await selectRange(page, 0, 11);
  await expect(selectK(page, 'style')).toHaveValue('');
  await expect(toggle(page, 'faux-italic')).toHaveAttribute('aria-pressed', 'mixed');
  // typing one more character at the end takes the regular style (A replacePlain / insertText)
  await selectRange(page, 11, 11);
  await page.evaluate(() => window.pigmentApp.tools.active.session.editor.focus());
  await page.keyboard.type('!');
  await expect.poll(() => runs(page, id, ['fontWeight', 'fauxItalic'])).toEqual([[5, { fontWeight: 700, fauxItalic: true }], [7, { fontWeight: null, fauxItalic: null }]]);
  // and inside the bold word, bold
  await selectRange(page, 2, 2);
  await page.keyboard.type('y');
  await expect.poll(() => page.evaluate((lid) => window.pigmentApp.doc.find(lid).text, id)).toBe('Heyllo world!');
  await expect.poll(() => runs(page, id, ['fontWeight'])).toEqual([[6, { fontWeight: 700 }], [7, { fontWeight: null }]]);
  // the caret's insertion style shows in the panel
  await expect(selectK(page, 'style')).toHaveValue('700');
  await expect(toggle(page, 'faux-italic')).toHaveAttribute('aria-pressed', 'true');
  // the whole session commits as one entry, and undo restores the plain text
  const before = await historyLength(page);
  await page.evaluate(() => window.pigmentApp.tools.active.commitSession());
  expect(await historyLength(page)).toBe(before + 1);
  await runAwait(page, 'edit:undo');
  await expect.poll(() => runs(page, id, ['fontWeight'])).toEqual([[11, { fontWeight: null }]]);
  expect(errors).toEqual([]);
});

test('moving the caret updates the panel; a caret change sets the insertion style; kerning at the caret', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  const id = await addText(page, { text: 'small LARGE', char: { size: 30 }, runs: [[6, 11, { size: 60, tracking: 50 }]] });
  await showPanel(page);
  await editLayer(page, id);
  await selectRange(page, 2, 2);
  await expect(field(page, 'size')).toHaveValue('30');
  await expect(field(page, 'tracking')).toHaveValue('0');
  await selectRange(page, 8, 8);
  await expect(field(page, 'size')).toHaveValue('60');
  await expect(field(page, 'tracking')).toHaveValue('50');
  await selectRange(page, 0, 11);
  await expect(field(page, 'size')).toHaveValue('');
  await expect(field(page, 'tracking')).toHaveValue('');
  // a caret: the size becomes the insertion style (the next typed characters), the text does not change
  await selectRange(page, 3, 3);
  await fillField(field(page, 'size'), 44);
  expect((await runs(page, id, ['size'])).map((r) => r[1].size)).toEqual([30, 60]);
  await page.evaluate(() => window.pigmentApp.tools.active.session.editor.focus());
  await page.keyboard.type('Z');
  await expect.poll(() => charAt(page, id, 3).then((s) => s.size)).toBe(44);
  // manual kerning at the caret: the pair around the insertion point (the character before it)
  await selectRange(page, 2, 2);
  await fillField(field(page, 'kern'), 120);
  await expect.poll(() => charAt(page, id, 1).then((s) => s.kern)).toBe(120);
  expect((await charAt(page, id, 2)).kern).toBe(0);
  await selectRange(page, 2, 2);
  await expect(field(page, 'kern')).toHaveValue('120');
  // the kerning method of a range
  await selectRange(page, 0, 5);
  await selectK(page, 'autoKern').selectOption('optical');
  await expect.poll(() => charAt(page, id, 0).then((s) => s.autoKern)).toBe('optical');
  expect((await charAt(page, id, 7)).autoKern).toBe('metrics');
  expect(errors).toEqual([]);
});

test('leading with Auto, scales, baseline shift, toggles and Reset Character on a layer, one entry each', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  const id = await addText(page, { text: 'Leading\nlines', char: { size: 40 } });
  await showPanel(page);
  // Auto shows the computed leading as the placeholder
  await expect(field(page, 'leading')).toHaveValue('');
  await expect(field(page, 'leading')).toHaveAttribute('placeholder', '(48)');
  let n = await historyLength(page);
  await fillField(field(page, 'leading'), 70);
  await expect.poll(() => charAt(page, id, 0).then((s) => s.leading)).toBe(70);
  expect(await historyLength(page)).toBe(++n);
  const lineGap = () => page.evaluate(async (lid) => {
    const api = await import('/lib/type/api.js');
    const lay = api.layoutText(window.pigmentApp.doc.find(lid));
    return lay.lines[1].baseline - lay.lines[0].baseline;
  }, id);
  expect(await lineGap()).toBeCloseTo(70, 5);
  await panel(page).locator('select[data-k="leadingPresets"]').selectOption({ label: 'Auto' });
  await expect.poll(() => charAt(page, id, 0).then((s) => s.leading)).toBe('auto');
  expect(await lineGap()).toBeCloseTo(48, 5);
  expect(await historyLength(page)).toBe(++n);

  await fillField(field(page, 'scaleY'), 150);
  await fillField(field(page, 'scaleX'), 80);
  await fillField(field(page, 'baselineShift'), -6);
  await fillField(field(page, 'tracking'), 25);
  for (const k of ['faux-bold', 'all-caps', 'superscript', 'underline', 'strike']) await toggle(page, k).click();
  await expect.poll(() => charAt(page, id, 0)).toMatchObject({ scaleY: 150, scaleX: 80, baselineShift: -6, tracking: 25, fauxBold: true, caps: 'all', position: 'super', underline: true, strike: true });
  expect(await historyLength(page)).toBe(n + 9);
  // small caps and subscript replace all caps and superscript
  await toggle(page, 'small-caps').click();
  await toggle(page, 'subscript').click();
  await expect.poll(() => charAt(page, id, 0)).toMatchObject({ caps: 'small', position: 'sub' });
  await expect(toggle(page, 'all-caps')).toHaveAttribute('aria-pressed', 'false');
  await expect(toggle(page, 'small-caps')).toHaveAttribute('aria-pressed', 'true');

  // Reset Character (the panel menu runs type:reset-character): everything but the face, size and colour
  await page.evaluate(() => window.pigmentApp.commands.isEnabled('type:reset-character')).then((v) => expect(v).toBe(true));
  expect(await page.evaluate(() => window.pigmentApp.stubbed.includes('type:reset-character'))).toBe(false);
  n = await historyLength(page);
  await panel(page).locator('.char-menu').click();
  await page.locator('.popover .popover-item', { hasText: 'Reset Character' }).click();
  await expect.poll(() => charAt(page, id, 0)).toMatchObject({ scaleY: 100, scaleX: 100, baselineShift: 0, tracking: 0, fauxBold: false, caps: 'normal', position: 'normal', underline: false, strike: false, leading: 'auto', size: 40 });
  expect(await historyLength(page)).toBe(n + 1);
  await runAwait(page, 'edit:undo');
  await expect.poll(() => charAt(page, id, 0)).toMatchObject({ scaleY: 150, caps: 'small' });
  expect(errors).toEqual([]);
});

test('several selected layers change together as one undo entry; mixed values show blank', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  const a = await addText(page, { text: 'First', char: { size: 30, color: '#ff0000' }, y: 20 });
  const b = await addText(page, { text: 'Second', char: { size: 50, color: '#0000ff' }, y: 120 });
  await page.evaluate(([x, y]) => {
    const d = window.pigmentApp.doc;
    d.selected.clear();
    d.selected.add(d.find(x));
    d.selected.add(d.find(y));
    d.changed('active');
  }, [a, b]);
  await showPanel(page);
  await expect(field(page, 'size')).toHaveValue('');
  await expect(field(page, 'tracking')).toHaveValue('0');
  const n = await historyLength(page);
  await fillField(field(page, 'tracking'), 75);
  await expect.poll(() => Promise.all([charAt(page, a, 0), charAt(page, b, 0)]).then((s) => s.map((x) => x.tracking))).toEqual([75, 75]);
  expect(await historyLength(page)).toBe(n + 1);
  await toggle(page, 'underline').click();
  await expect.poll(() => Promise.all([charAt(page, a, 0), charAt(page, b, 0)]).then((s) => s.map((x) => x.underline))).toEqual([true, true]);
  expect(await historyLength(page)).toBe(n + 2);
  // the sizes stay their own
  expect((await charAt(page, a, 0)).size).toBe(30);
  expect((await charAt(page, b, 0)).size).toBe(50);
  await runAwait(page, 'edit:undo');
  await runAwait(page, 'edit:undo');
  await expect.poll(() => Promise.all([charAt(page, a, 0), charAt(page, b, 0)]).then((s) => s.map((x) => [x.tracking, x.underline]))).toEqual([[0, false], [0, false]]);
  expect(errors).toEqual([]);
});

test('language, fractional widths, no break, system layout, anti-aliasing and point / paragraph text', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  const id = await addText(page, { text: 'Hallo Welt', runs: [[0, 5, { language: 'de' }]] });
  await showPanel(page);
  // the list holds the document's languages; the mixed layer shows blank
  await expect(selectK(page, 'language')).toHaveValue('');
  const langs = await selectK(page, 'language').locator('option').evaluateAll((os) => os.map((o) => o.value));
  expect(langs).toEqual(expect.arrayContaining(['de', 'en-US']));
  await selectK(page, 'language').selectOption('de');
  await expect.poll(() => charAt(page, id, 8).then((s) => s.language)).toBe('de');

  // the panel menu's check boxes
  const menu = async (label) => {
    await panel(page).locator('.char-menu').click();
    await page.locator('.popover .popover-item', { hasText: label }).click();
  };
  const n = await historyLength(page);
  await menu('Fractional Widths');
  await expect.poll(() => charAt(page, id, 0).then((s) => s.fractionalWidths)).toBe(false);
  await menu('No Break');
  await expect.poll(() => charAt(page, id, 0).then((s) => s.noBreak)).toBe(true);
  await menu('System Layout');
  await expect.poll(() => page.evaluate((lid) => window.pigmentApp.doc.find(lid).typeOptions.systemLayout, id)).toBe(true);
  expect(await historyLength(page)).toBe(n + 3);
  await selectK(page, 'antiAlias').selectOption('crisp');
  await expect.poll(() => page.evaluate((lid) => window.pigmentApp.doc.find(lid).typeOptions.antiAlias, id)).toBe('crisp');

  // point text -> paragraph text: a box around the text as laid out; then its width; back to point text
  await selectK(page, 'box').selectOption('paragraph');
  const w = await page.evaluate((lid) => window.pigmentApp.doc.find(lid).width, id);
  expect(w).toBeGreaterThan(50);
  await fillField(field(page, 'boxWidth'), 90);
  await expect.poll(() => page.evaluate((lid) => window.pigmentApp.doc.find(lid).width, id)).toBe(90);
  await fillField(field(page, 'boxHeight'), 200);
  await expect.poll(() => page.evaluate((lid) => window.pigmentApp.doc.find(lid).height, id)).toBe(200);
  await selectK(page, 'box').selectOption('point');
  await expect.poll(() => page.evaluate((lid) => { const l = window.pigmentApp.doc.find(lid); return [l.width, l.height]; }, id)).toEqual([null, null]);
  expect(errors).toEqual([]);
});

test('with no text layer the panel edits the defaults for new text', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  await showPanel(page);
  await expect(panel(page).locator('.char-empty')).toBeVisible();
  await fillField(field(page, 'tracking'), 40);
  await toggle(page, 'underline').click();
  await expect.poll(() => page.evaluate(() => window.pigmentApp.settings.type.char)).toMatchObject({ tracking: 40, underline: true });
  // a new point text starts with them, in its creation entry
  await page.evaluate(() => window.pigmentApp.tools.activate('type-horizontal'));
  const before = await historyLength(page);
  const box = await page.locator('canvas.view').boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect.poll(() => page.evaluate(() => !!window.pigmentApp.tools.active?.session)).toBe(true);
  await page.keyboard.type('New');
  await page.evaluate(() => window.pigmentApp.tools.active.commitSession());
  const style = await page.evaluate(async () => {
    const M = await import('/lib/type/model.js');
    return M.charStyleAt(window.pigmentApp.doc.active.content, 0);
  });
  expect(style).toMatchObject({ tracking: 40, underline: true });
  expect(await historyLength(page)).toBe(before + 1);
  expect(errors).toEqual([]);
});

test('the Properties text section edits the layer like the panel', async ({ page }) => {
  const errors = await openApp(page);
  await setUnit(page, 'pt');
  await newDoc(page, { dpi: 144 });
  const id = await addText(page, { text: 'Props', char: { size: 40 } });
  await runAwait(page, 'window:panel-properties');
  const props = page.locator('.panel[data-panel="properties"] .props-text');
  await expect(props).toBeVisible();
  // 40 px at 144 ppi = 20 pt
  await expect(props.locator('input[data-key="size"]')).toHaveValue('20');
  const n = await historyLength(page);
  await props.locator('input[data-key="size"]').fill('30');
  await props.locator('input[data-key="size"]').dispatchEvent('change');
  await expect.poll(() => charAt(page, id, 0).then((s) => s.size)).toBe(60);
  await props.locator('.char-toggle[data-k="strike"]').click();
  await expect.poll(() => charAt(page, id, 0).then((s) => s.strike)).toBe(true);
  expect(await historyLength(page)).toBe(n + 2);
  await expect(props.locator('.char-toggle[data-k="strike"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(props.locator('button', { hasText: 'Edit Text' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('sections registered for the Character panel render after its controls or replace a row', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  await addText(page, { text: 'Sections' });
  await showPanel(page);
  await page.evaluate(async () => {
    const { registerTypeSection } = await import('/lib/type/sections.js');
    registerTypeSection('character', { id: 'test-extra', order: 10, render: ({ attrs }) => Object.assign(document.createElement('div'), { className: 'test-extra', textContent: `size ${attrs.size}` }) });
    registerTypeSection('character', { id: 'test-family', replaces: 'family', render: () => Object.assign(document.createElement('div'), { className: 'test-family', textContent: 'my fonts' }) });
  });
  await expect(panel(page).locator('.char-sections .test-extra')).toHaveText('size 40');
  await expect(panel(page).locator('[data-row="family"] .test-family')).toHaveText('my fonts');
  await expect(selectK(page, 'family')).toBeHidden();
  expect(errors).toEqual([]);
});

const FAMILY = 'Pigment Test Carlito';

test('optical kerning spaces pairs by their outlines with HarfBuzz', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 900, height: 300 });
  await page.evaluate(async (family) => {
    const bytes = new Uint8Array(await (await fetch('/fixtures/fonts/Carlito-Regular.ttf')).arrayBuffer());
    return window.__pigmentTest.addFont(bytes, { family });
  }, FAMILY);
  const id = await addText(page, { text: 'To nnn', char: { size: 100, fontFamily: FAMILY } });
  /** The x of each cluster start of the layout (HarfBuzz engine). */
  const xs = (mode) => page.evaluate(async ([lid, m]) => {
    const app = window.pigmentApp;
    const M = await import('/lib/type/model.js');
    const api = await import('/lib/type/api.js');
    const l = app.doc.find(lid);
    l.content = M.applyChar(l.content, 0, M.contentLength(l.content), { autoKern: m });
    l.touch();
    const lay = api.layoutText(l);
    return { engine: lay.engine, xs: lay.lines[0].runs.flatMap((r) => r.clusters.map((c) => c.x)) };
  }, [id, mode]);
  await expect.poll(() => xs('none').then((r) => r.engine)).toBe('harfbuzz');
  const none = await xs('none');
  const optical = await xs('optical');
  expect(optical.engine).toBe('harfbuzz');
  // "To": the o moves under the T's bar
  const gapNone = none.xs[1] - none.xs[0];
  const gapOptical = optical.xs[1] - optical.xs[0];
  expect(gapOptical).toBeLessThan(gapNone - 3);
  // "nn": straight stems keep (about) their designed spacing: within 3 % of an em
  const nn = (r) => r.xs[4] - r.xs[3];
  expect(Math.abs(nn(optical) - nn(none))).toBeLessThan(3);
  // the kerner is the one this package registered, and it declines (metrics) without face data
  const declines = await page.evaluate(async () => {
    const api = await import('/lib/type/api.js');
    const fn = api.kerner('optical');
    return fn({ fontFamily: 'No Such Font', size: 20, fontWeight: 400, fontItalic: false, scaleX: 100, position: 'normal', caps: 'normal' }, 'AV', [null, null]);
  });
  expect(declines).toBeNull();
  // the panel shows Optical
  await showPanel(page);
  await expect(selectK(page, 'autoKern')).toHaveValue('optical');
  expect(errors).toEqual([]);
});
