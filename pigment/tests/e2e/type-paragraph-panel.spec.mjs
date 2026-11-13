// type-paragraph-panel (0.4, package 4): the Paragraph panel, the Properties paragraph section, the Hyphenation and
// Justification dialogs, the composers, the UAX 14 breaker, hyphenation and lists (ARCHITECTURE.md "0.4 features", A,
// B.2, B.7, L.1, L.14). The tests run on the stub engine ('canvas'), which calls the composers as the HarfBuzz engine
// does; the last one loads the OFL test font so the HarfBuzz engine lays out a justified, hyphenated paragraph.
import { test, expect } from '@playwright/test';
import { openApp, newDoc, runAwait, historyLength } from './helpers.mjs';

const panel = (page) => page.locator('.panel.para-panel');
const field = (page, k) => panel(page).locator(`input[data-key="${k}"]`);
const alignBtn = (page, a) => panel(page).locator(`.para-align[data-align="${a}"]`);
const dialog = (page) => page.locator('.dialog');

/** Adds a text layer from model content: spec = { text, char, para, x, y, width, name }. Returns its id. */
const addText = (page, spec) =>
  page.evaluate(async (s) => {
    const app = window.pigmentApp;
    const { TextLayer } = await import('/lib/document.js');
    const { structural } = await import('/lib/layer-ops.js');
    const M = await import('/lib/type/model.js');
    let content = M.fromPlain(s.text, s.char ?? { size: 20 });
    if (s.para) content = M.applyPara(content, 0, s.text.length, s.para);
    for (const [a, b, patch] of s.paras ?? []) content = M.applyPara(content, a, b, patch);
    const layer = s.legacy ? new TextLayer({ text: s.text, font: s.legacy, x: s.x ?? 20, y: s.y ?? 20, width: s.width ?? null }) : new TextLayer({ content, x: s.x ?? 20, y: s.y ?? 20, width: s.width ?? null });
    layer.name = s.name ?? s.text.slice(0, 20);
    structural(app, 'Add', () => {
      app.doc.add(layer);
      app.doc.setActive(layer);
    });
    return layer.id;
  }, spec);
/** The resolved paragraph styles of a layer, the keys asked for. */
const paras = (page, id, keys) =>
  page.evaluate(async ([lid, ks]) => {
    const M = await import('/lib/type/model.js');
    return M.paragraphs(window.pigmentApp.doc.find(lid).content).map((p) => Object.fromEntries(ks.map((k) => [k, p.style[k]])));
  }, [id, keys]);
/** The displayed lines of a layer: [text, hyphen]. */
const lines = (page, id) =>
  page.evaluate(async (lid) => {
    const api = await import('/lib/type/api.js');
    return api.layoutText(window.pigmentApp.doc.find(lid)).lines.map((l) => [l.text, l.hyphen]);
  }, id);
const showPanel = async (page) => {
  await runAwait(page, 'window:panel-paragraph');
  await expect(panel(page)).toBeVisible();
};
const editLayer = async (page, id) => {
  await runAwait(page, 'layer:edit-text', id);
  await expect.poll(() => page.evaluate(() => !!window.pigmentApp.tools.active?.session)).toBe(true);
};
const selectRange = (page, a, b) => page.evaluate(([x, y]) => window.pigmentApp.tools.active.session.editor.select(x, y), [a, b]);
const fillField = async (locator, value) => {
  await locator.fill(String(value));
  await locator.press('Enter');
};
const openMenu = async (page) => {
  await panel(page).locator('.para-menu').click();
  await expect(page.locator('.popover')).toBeVisible();
};
const menuItem = (page, label) => page.locator('.popover .popover-item', { hasText: label });

const TEXT = 'In olden times when wishing still helped one, there lived a king whose daughters were all beautiful; and the youngest was so beautiful that the sun itself was astonished whenever it shone in her face.';

test('the package replaced its stubs: panel, commands, composers, breaker, hyphenator and list formatter', async ({ page }) => {
  const errors = await openApp(page);
  const info = await page.evaluate(async () => {
    const app = window.pigmentApp;
    const api = await import('/lib/type/api.js');
    const ids = ['window:panel-paragraph', 'type:reset-paragraph', 'type:hyphenation-settings', 'type:justification-settings', 'type:toggle-panels'];
    return {
      stubbed: ids.filter((id) => app.stubbed.includes(id)),
      enabled: ids.map((id) => app.commands.isEnabled?.(id) ?? true),
      composers: [api.composer('single').name, api.composer('every').name],
      languages: api.hyphenationLanguages(),
      panel: app.panels.panels.has('paragraph'),
    };
  });
  expect(info.stubbed).toEqual([]);
  expect(info.enabled.every(Boolean)).toBe(true);
  expect(info.composers).toEqual(['Adobe Single-line Composer', 'Adobe Every-line Composer']);
  expect(info.languages).toEqual(expect.arrayContaining(['en-US', 'en-GB', 'de', 'fr', 'es', 'it', 'nl', 'pt']));
  expect(info.panel).toBe(true);
  expect(errors).toEqual([]);
});

test('alignment, indents and spacing apply to the selected layer as one entry each; undo restores them', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 500, height: 400 });
  const id = await addText(page, { text: 'First paragraph\nSecond paragraph', width: 300 });
  await showPanel(page);
  await expect(alignBtn(page, 'left')).toHaveAttribute('aria-pressed', 'true');
  for (const [a] of [['center'], ['right'], ['justify-left'], ['justify-center'], ['justify-right'], ['justify-all']]) {
    const before = await historyLength(page);
    await alignBtn(page, a).click();
    await expect.poll(() => paras(page, id, ['align'])).toEqual([{ align: a }, { align: a }]);
    await expect(alignBtn(page, a)).toHaveAttribute('aria-pressed', 'true');
    expect(await historyLength(page)).toBe(before + 1);
  }
  await fillField(field(page, 'indentLeft'), 12);
  await fillField(field(page, 'indentFirst'), -6);
  await fillField(field(page, 'spaceAfter'), 8);
  await expect.poll(() => paras(page, id, ['indentLeft', 'indentFirst', 'spaceAfter'])).toEqual([{ indentLeft: 12, indentFirst: -6, spaceAfter: 8 }, { indentLeft: 12, indentFirst: -6, spaceAfter: 8 }]);
  // the engine places them: the second paragraph's first line starts at x + 12 − 6
  const geo = await page.evaluate(async (lid) => {
    const api = await import('/lib/type/api.js');
    const l = window.pigmentApp.doc.find(lid);
    const lay = api.layoutText(l);
    return { x: l.x, first: lay.lines[1].x, gap: lay.lines[1].top - (lay.lines[0].top + lay.lines[0].height) };
  }, id);
  expect(geo.first).toBeCloseTo(geo.x + 6, 6);
  expect(geo.gap).toBeCloseTo(8, 6);
  // (Edit > Undo in a focused field is the field's own undo: leave it first)
  await page.evaluate(() => document.activeElement?.blur());
  await runAwait(page, 'edit:undo');
  await expect.poll(() => paras(page, id, ['spaceAfter'])).toEqual([{ spaceAfter: 0 }, { spaceAfter: 0 }]);
  await expect(field(page, 'spaceAfter')).toHaveValue('0');
  expect(errors).toEqual([]);
});

test('while editing, the panel changes the paragraphs under the selection only; the session commits as one entry', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 500, height: 400 });
  const id = await addText(page, { text: 'One\nTwo\nThree', width: 300 });
  await showPanel(page);
  await editLayer(page, id);
  // a caret in "Two": its paragraph
  await selectRange(page, 5, 5);
  await alignBtn(page, 'center').click();
  await expect.poll(() => paras(page, id, ['align'])).toEqual([{ align: 'left' }, { align: 'center' }, { align: 'left' }]);
  // a range over "Two" and "Three": both, and the panel shows mixed alignment for a range over all three
  await selectRange(page, 5, 10);
  await fillField(field(page, 'indentRight'), 7);
  await expect.poll(() => paras(page, id, ['indentRight'])).toEqual([{ indentRight: 0 }, { indentRight: 7 }, { indentRight: 7 }]);
  await selectRange(page, 0, 13);
  await expect(panel(page).locator('.para-align[aria-pressed="true"]')).toHaveCount(0);
  await expect(field(page, 'indentRight')).toHaveValue('');
  const before = await historyLength(page);
  await page.evaluate(() => window.pigmentApp.tools.active.commitSession());
  expect(await historyLength(page)).toBe(before + 1);
  expect(errors).toEqual([]);
});

test('Hyphenation dialog: each field shows its own mixed state; OK changes only the fields edited, as one entry', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 500, height: 400 });
  const id = await addText(page, {
    text: 'Alpha\nBeta',
    width: 300,
    paras: [[0, 0, { hyphenation: { minWord: 5, after: 3, before: 2, limit: 2, zone: 36, capitalized: true, lastWord: true, acrossColumn: true } }], [6, 6, { hyphenate: true, hyphenation: { minWord: 9, after: 3, before: 2, limit: 2, zone: 36, capitalized: false, lastWord: true, acrossColumn: true } }]],
  });
  await showPanel(page);
  await expect(panel(page).locator('input[data-k="hyphenate"]')).toHaveJSProperty('indeterminate', true);
  // (the command resolves when the dialog closes: not awaited here)
  const openHyphenation = () => page.evaluate(() => void window.pigmentApp.commands.run('type:hyphenation-settings', undefined, 'api'));
  await openHyphenation();
  const d = dialog(page);
  await expect(d.locator('input[data-key="minWord"]')).toHaveValue('');
  await expect(d.locator('input[data-key="minWord"]')).toHaveAttribute('placeholder', 'Mixed');
  await expect(d.locator('input[data-key="after"]')).toHaveValue('3');
  await expect(d.locator('input[data-key="capitalized"]')).toHaveJSProperty('indeterminate', true);
  await expect(d.locator('input[data-key="hyphenate"]')).toHaveJSProperty('indeterminate', true);
  const before = await historyLength(page);
  await d.locator('input[data-key="after"]').fill('4');
  await d.locator('input[data-key="hyphenate"]').check();
  await d.locator('.dialog-buttons button', { hasText: 'OK' }).click();
  await expect(d).toHaveCount(0);
  await expect.poll(() => paras(page, id, ['hyphenate', 'hyphenation'])).toEqual([
    { hyphenate: true, hyphenation: { minWord: 5, after: 4, before: 2, limit: 2, zone: 36, capitalized: true, lastWord: true, acrossColumn: true } },
    { hyphenate: true, hyphenation: { minWord: 9, after: 4, before: 2, limit: 2, zone: 36, capitalized: false, lastWord: true, acrossColumn: true } },
  ]);
  expect(await historyLength(page)).toBe(before + 1);
  // Cancel changes nothing
  await openHyphenation();
  await d.locator('input[data-key="limit"]').fill('5');
  await d.locator('.dialog-buttons button', { hasText: 'Cancel' }).click();
  expect(await historyLength(page)).toBe(before + 1);
  expect(errors).toEqual([]);
});

test('Justification dialog: spacing, auto leading and single word justification; Minimum above Desired is refused', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 500, height: 400 });
  const id = await addText(page, { text: TEXT, width: 260, para: { align: 'justify-left' } });
  await showPanel(page);
  await openMenu(page);
  await menuItem(page, 'Justification…').click();
  const d = dialog(page);
  await expect(d.locator('input[data-key="wordDes"]')).toHaveValue('100');
  await d.locator('input[data-key="wordMin"]').fill('120');
  await d.locator('.dialog-buttons button', { hasText: 'OK' }).click();
  await expect(d.locator('.para-error')).toBeVisible();
  await d.locator('input[data-key="wordMin"]').fill('70');
  await d.locator('input[data-key="letterMax"]').fill('10');
  await d.locator('input[data-key="autoLeading"]').fill('150');
  await d.locator('select[data-key="singleWord"]').selectOption('center');
  await d.locator('.dialog-buttons button', { hasText: 'OK' }).click();
  await expect(d).toHaveCount(0);
  await expect.poll(() => paras(page, id, ['justification'])).toEqual([{ justification: { word: [70, 100, 133], letter: [0, 0, 10], glyph: [100, 100, 100], autoLeading: 150, singleWord: 'center' } }]);
  // auto leading 150 % of 20 px: the lines are 30 px apart
  const step = await page.evaluate(async (lid) => {
    const api = await import('/lib/type/api.js');
    const lay = api.layoutText(window.pigmentApp.doc.find(lid));
    return lay.lines[1].baseline - lay.lines[0].baseline;
  }, id);
  expect(step).toBeCloseTo(30, 6);
  expect(errors).toEqual([]);
});

test('a justify-all paragraph that hyphenates is set by the Every-line Composer: flush lines and hyphens', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 500, height: 400 });
  const id = await addText(page, { text: TEXT, width: 260, para: { align: 'justify-all', hyphenate: true } });
  await expect.poll(() => page.evaluate(async () => (await import('/lib/type/hyphenation.js')).languageReady('en-US'))).toBe(true);
  const r = await page.evaluate(async (lid) => {
    const api = await import('/lib/type/api.js');
    const M = await import('/lib/type/model.js');
    const l = window.pigmentApp.doc.find(lid);
    l.touch();
    const lay = api.layoutText(l);
    const st = M.paragraphs(l.content)[0].style;
    // the composer the engine used: the same breaks from the composer itself
    return { composer: st.composer, engine: lay.engine, lines: lay.lines.map((x) => [x.text, x.hyphen]), runsEnd: lay.lines.map((x) => { const last = x.runs[x.runs.length - 1]; return last.x + last.advance + (x.hyphen ? 0 : 0) - l.x; }) };
  }, id);
  expect(r.composer).toBe('every');
  expect(r.lines.length).toBeGreaterThan(4);
  expect(r.lines.some(([, h]) => h)).toBe(true);
  // every line but hyphenated ones ends at the box's right edge (the stub draws the hyphen after the last run)
  r.lines.forEach(([, hyph], i) => {
    if (!hyph) expect(r.runsEnd[i]).toBeCloseTo(260, 0);
  });
  // the Single-line Composer sets the same paragraph line by line (different breaks)
  await showPanel(page);
  await openMenu(page);
  await menuItem(page, 'Adobe Single-line Composer').click();
  await expect.poll(() => paras(page, id, ['composer'])).toEqual([{ composer: 'single' }]);
  expect(errors).toEqual([]);
});

test('a version 2 paragraph (single composer, legacy breaks) keeps 0.3\'s lines, "well-known" and CJK included; standard rules break them', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 500, height: 400 });
  const text = 'Our well-known 日本語のテキストです and some more words to wrap well-known lines';
  const font = { family: 'Arial', size: 18, color: '#000000', align: 'left', lineHeight: 1.2 };
  const id = await addText(page, { text, legacy: font, width: 150 });
  const expected = await page.evaluate(([t, w]) => {
    // 0.3's wrap: words split at U+0020, a word that does not fit starts a new line
    const ctx = document.createElement('canvas').getContext('2d');
    ctx.font = '18px Arial';
    const out = [];
    let line = '';
    for (const word of t.split(' ')) {
      const next = line ? `${line} ${word}` : word;
      if (line && ctx.measureText(next).width > w) {
        out.push(line);
        line = word;
      } else line = next;
    }
    out.push(line);
    return out;
  }, [text, 150]);
  await expect.poll(() => paras(page, id, ['composer', 'breakRules'])).toEqual([{ composer: 'single', breakRules: 'legacy' }]);
  expect((await lines(page, id)).map(([t]) => t)).toEqual(expected);
  // the same text with the standard rules may break after the hyphen and between ideographs
  await showPanel(page);
  await openMenu(page);
  await menuItem(page, 'Standard (Unicode)').click();
  await expect.poll(() => paras(page, id, ['breakRules'])).toEqual([{ breakRules: 'standard' }]);
  const std = (await lines(page, id)).map(([t]) => t);
  expect(std).not.toEqual(expected);
  expect(std.some((t) => /[\u3040-\u30ff\u4e00-\u9fff]$/u.test(t) || t.endsWith('well-'))).toBe(true);
  expect(errors).toEqual([]);
});

test('lists: bulleted and numbered from the panel, markers by level and style, start number; Reset Paragraph', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 500, height: 400 });
  const id = await addText(page, { text: 'Apples\nPears\nPlums', width: 300 });
  await showPanel(page);
  await panel(page).locator('.para-list-btn[data-list="bullet"]').click();
  await expect.poll(() => paras(page, id, ['list', 'indentLeft'])).toEqual(Array(3).fill({ list: { type: 'bullet', marker: '•', start: 1, level: 0 }, indentLeft: 30 }));
  const markers = () => page.evaluate(async (lid) => {
    const api = await import('/lib/type/api.js');
    const l = window.pigmentApp.doc.find(lid);
    return l.content.paras.map((_, i) => api.listMarkerText(l.content.paras, i));
  }, id);
  expect(await markers()).toEqual(['•', '•', '•']);
  await panel(page).locator('.para-list-btn[data-list="number"]').click();
  await expect.poll(markers).toEqual(['1.', '2.', '3.']);
  await panel(page).locator('select[data-k="listMarker"]').selectOption('upper-roman');
  await fillField(field(page, 'listStart'), 4);
  await expect.poll(markers).toEqual(['IV.', 'V.', 'VI.']);
  // the stub engine draws the marker in the indent
  const marker = await page.evaluate(async (lid) => (await import('/lib/type/api.js')).layoutText(window.pigmentApp.doc.find(lid)).lines[0]._list ?? null, id);
  expect(marker).toBe('IV.');
  await openMenu(page);
  await menuItem(page, 'Reset Paragraph').click();
  await expect.poll(() => paras(page, id, ['list', 'indentLeft', 'align'])).toEqual(Array(3).fill({ list: null, indentLeft: 0, align: 'left' }));
  await runAwait(page, 'edit:undo');
  await expect.poll(markers).toEqual(['IV.', 'V.', 'VI.']);
  expect(errors).toEqual([]);
});

test('Roman Hanging Punctuation puts an opening quote into the left margin; the Hyphenate box hyphenates in the layer\'s language', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 500, height: 400 });
  const id = await addText(page, { text: '“Quoted text that wraps over several lines of the box,” she said.', width: 200 });
  await showPanel(page);
  await openMenu(page);
  await menuItem(page, 'Roman Hanging Punctuation').click();
  await expect.poll(() => paras(page, id, ['hangingPunctuation'])).toEqual([{ hangingPunctuation: true }]);
  const x0 = await page.evaluate(async (lid) => {
    const l = window.pigmentApp.doc.find(lid);
    return (await import('/lib/type/api.js')).layoutText(l).lines[0].x - l.x;
  }, id);
  expect(x0).toBeLessThan(-2);
  // German text: the patterns load on demand and the layer is laid out again with hyphens
  const de = await addText(page, { text: 'Donaudampfschifffahrtsgesellschaftskapitän Silbentrennungsalgorithmus', char: { size: 20, language: 'de' }, width: 160, y: 200 });
  await panel(page).locator('input[data-k="hyphenate"]').check();
  await expect.poll(() => paras(page, de, ['hyphenate'])).toEqual([{ hyphenate: true }]);
  await expect.poll(async () => (await lines(page, de)).some(([, h]) => h)).toBe(true);
  expect(errors).toEqual([]);
});

test('the Properties paragraph section edits like the panel; with no text layer the panel edits the defaults for new text', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 500, height: 400 });
  const id = await addText(page, { text: 'Props', width: 300 });
  await runAwait(page, 'window:panel-properties');
  const section = page.locator('.props-paragraph');
  await expect(section).toBeVisible();
  await section.locator('.para-align[data-align="right"]').click();
  await expect.poll(() => paras(page, id, ['align'])).toEqual([{ align: 'right' }]);
  await section.locator('input[data-key="spaceBefore"]').fill('5');
  await section.locator('input[data-key="spaceBefore"]').press('Enter');
  await expect.poll(() => paras(page, id, ['spaceBefore'])).toEqual([{ spaceBefore: 5 }]);
  // nothing targeted: the defaults (settings.type.para; the alignment is the type tools' option)
  await page.evaluate(() => {
    const d = window.pigmentApp.doc;
    d.setActive(null);
    d.selected?.clear?.();
  });
  await showPanel(page);
  await expect(panel(page).locator('.para-empty')).toBeVisible();
  await fillField(field(page, 'indentLeft'), 9);
  await alignBtn(page, 'justify-all').click();
  const defaults = await page.evaluate(() => ({ para: window.pigmentApp.settings.type.para, align: window.pigmentApp.tools.get('type-horizontal').opt('align') }));
  expect(defaults.para.indentLeft).toBe(9);
  expect(defaults.align).toBe('justify-all');
  expect(errors).toEqual([]);
});

test('new text gets the Every-line Composer and Unicode line breaks; the options-bar button toggles the type panels', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 500, height: 400 });
  await page.evaluate(() => window.pigmentApp.tools.activate('type-horizontal'));
  const canvas = page.locator('.doc-frame:not([hidden]) canvas.view');
  const box = await canvas.boundingBox();
  await page.mouse.click(box.x + 100, box.y + 100);
  await expect.poll(() => page.evaluate(() => !!window.pigmentApp.tools.active?.session)).toBe(true);
  await page.keyboard.type('Hello');
  const id = await page.evaluate(() => window.pigmentApp.tools.active.session.layer.id);
  await page.evaluate(() => window.pigmentApp.tools.active.commitSession());
  await expect.poll(() => paras(page, id, ['composer', 'breakRules'])).toEqual([{ composer: 'every', breakRules: 'standard' }]);
  // the toggle: Character first; pressed again, the panel shown before comes back
  await runAwait(page, 'window:panel-properties');
  await runAwait(page, 'type:toggle-panels');
  await expect.poll(() => page.evaluate(() => window.pigmentApp.panels.isVisible('character'))).toBe(true);
  await runAwait(page, 'type:toggle-panels');
  await expect.poll(() => page.evaluate(() => window.pigmentApp.panels.isVisible('properties'))).toBe(true);
  expect(errors).toEqual([]);
});

test('with the HarfBuzz engine the Every-line Composer justifies to the box', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 500, height: 400 });
  await page.evaluate(async () => {
    const bytes = new Uint8Array(await (await fetch('/fixtures/fonts/Carlito-Regular.ttf')).arrayBuffer());
    await window.__pigmentTest.addFont(bytes, { family: 'PigmentTest Carlito' });
  });
  const id = await addText(page, { text: TEXT, char: { size: 18, fontFamily: 'PigmentTest Carlito' }, width: 240, para: { align: 'justify-left', hyphenate: true } });
  const r = await page.evaluate(async (lid) => {
    const api = await import('/lib/type/api.js');
    const l = window.pigmentApp.doc.find(lid);
    const lay = api.layoutText(l);
    return { engine: lay.engine, widths: lay.lines.map((x) => x.width), last: lay.lines.map((x) => x.last) };
  }, id);
  expect(r.engine).toBe('harfbuzz');
  r.widths.forEach((w, i) => {
    if (!r.last[i]) expect(w).toBeCloseTo(240, 1);
  });
  expect(errors).toEqual([]);
});
