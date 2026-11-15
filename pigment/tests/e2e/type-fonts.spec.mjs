// type-fonts (ARCHITECTURE.md "0.5 features", package 12; port 8862): the font catalog, the font menu and widgets,
// real styles and variable axes on text, Add Fonts, the hover preview, missing fonts on open and missing glyph
// protection. Fixtures: tests/fixtures/fonts (Liberation Sans, Carlito: SIL OFL 1.1) and the bundled Source Sans 3 VF.
import { test, expect } from '@playwright/test';
import { openApp, newDoc, runAwait, run } from './helpers.mjs';

const VF = 'SourceSans3VF';

/** Adds a text layer through the model and selects it; returns its id. */
async function addText(page, { text = 'Hello', char = {}, x = 20, y = 40 } = {}) {
  return page.evaluate(async ({ text: t, char: c, x: px, y: py }) => {
    const app = window.pigmentApp;
    const { TextLayer } = await import('/lib/document.js');
    const M = await import('/lib/type/model.js');
    const layer = new TextLayer({ content: M.fromPlain(t, { size: 48, color: '#000000', ...c }), x: px, y: py });
    app.doc.add(layer);
    app.doc.setActive(layer);
    app.doc.changed('tree');
    return layer.id;
  }, { text, char, x, y });
}
const runsOf = (page, id, keys) => page.evaluate(([lid, ks]) => window.pigmentApp.doc.find(lid).content.runs.map((r) => [r.len, Object.fromEntries(ks.map((k) => [k, r.style[k] ?? null]))]), [id, keys]);
const historyLength = (page) => page.evaluate(() => window.pigmentApp.doc.history.index);
/** Waits until the layer is drawn by HarfBuzz (its faces loaded). */
const engineOf = (page, id) => page.evaluate((lid) => window.pigmentApp.doc.find(lid).layout().engine, id);
const ready = (page) => page.evaluate(async () => {
  const { fontCatalog } = await import('/lib/type/api.js');
  try {
    await fontCatalog().ready();
  } finally {
    await new Promise((r) => setTimeout(r, 0));
  }
});

test('the real catalog replaced the stub: bundled family with real styles, classes, search, favourites and recents', async ({ page }) => {
  const errors = await openApp(page);
  await ready(page);
  const r = await page.evaluate(async (vf) => {
    const app = window.pigmentApp;
    const { fontCatalog } = await import('/lib/type/api.js');
    const c = fontCatalog();
    const fam = c.family(vf);
    const mono = c.families({ classes: ['monospace'] }).map((f) => f.name);
    c.favourites.toggle(vf);
    const favs = c.families({ favourites: true }).map((f) => f.name);
    c.recent.push('Arial');
    c.recent.push(vf);
    return {
      real: c.real,
      stubbed: app.stubbed.filter((id) => ['type:add-fonts', 'type:font-preview-size', 'type:manage-missing-fonts', 'type:replace-missing-fonts'].includes(id)),
      source: fam.source,
      variable: fam.variable,
      classification: fam.classification,
      styles: fam.styles.map((s) => [s.name, s.postScriptName, s.weight, s.italic]).slice(0, 6),
      count: fam.styles.length,
      search: c.families({ search: 'sourcesans' }).map((f) => f.name),
      searchStyle: c.families({ search: 'semibold italic' }).map((f) => f.name),
      mono: mono.every((n) => c.family(n).classification === 'monospace') && mono.length > 0,
      favs,
      settingsFav: app.settings.typeFonts.favourites,
      recent: c.recent.list().slice(0, 2),
      // 0.4's detected families keep 0.4's keys; a bundled family's keys are PostScript names
      arialKey: c.styleKey({ fontFamily: 'Arial', fontWeight: 700, fontItalic: true }),
      vfKey: c.styleKey({ fontFamily: vf, fontWeight: 700, fontItalic: false }),
      vfCustom: c.styleKey({ fontFamily: vf, fontWeight: 650, fontItalic: false, axes: { wght: 650 } }),
      patch: c.stylePatch(vf, 'SourceSans3VF-Semibold'),
      legacyPatch: c.stylePatch(vf, '700i'),
      newFamily: c.stylePatch('Arial', 'SourceSans3VF-Bold'),
      ps: c.fromPostScriptName('SourceSans3VF-BlackItalic'),
      unknownPs: c.fromPostScriptName('MyriadPro-BoldIt'),
      resolved: c.resolve({ fontFamily: vf, fontWeight: 700, fontItalic: false }),
      missing: c.resolve({ fontFamily: 'No Such Family Anywhere' }),
      axes: await c.axes(vf),
    };
  }, VF);
  expect(r.real).toBe(true);
  expect(r.stubbed).toEqual([]);
  expect(r).toMatchObject({ source: 'bundled', variable: true, classification: 'sans-serif', count: 14 });
  expect(r.styles).toEqual([['ExtraLight', 'SourceSans3VF-ExtraLight', 200, false], ['ExtraLight Italic', 'SourceSans3VF-ExtraLightItalic', 200, true], ['Light', 'SourceSans3VF-Light', 300, false], ['Light Italic', 'SourceSans3VF-LightItalic', 300, true], ['Regular', 'SourceSans3VF-Regular', 400, false], ['Italic', 'SourceSans3VF-Italic', 400, true]]);
  expect(r.search).toEqual([VF]);
  expect(r.searchStyle).toContain(VF);
  expect(r.mono).toBe(true);
  expect(r.favs).toEqual([VF]);
  expect(r.settingsFav).toEqual([VF]);
  expect(r.recent).toEqual([VF, 'Arial']);
  expect(r.arialKey).toBe('700i');
  expect(r.vfKey).toBe('SourceSans3VF-Bold');
  expect(r.vfCustom).toBe('SourceSans3VF-Bold|wght=650');
  expect(r.patch).toEqual({ fontFamily: VF, fontWeight: 600, fontItalic: false, postScriptName: 'SourceSans3VF-Semibold', axes: {} });
  expect(r.legacyPatch).toEqual({ fontFamily: VF, fontWeight: 700, fontItalic: true, postScriptName: 'SourceSans3VF-BoldItalic', axes: {} });
  expect(r.newFamily).toEqual({ fontFamily: 'Arial', fontWeight: 700, fontItalic: false, postScriptName: null, axes: {} });
  expect(r.ps).toEqual({ family: VF, style: { name: 'Black Italic', postScriptName: 'SourceSans3VF-BlackItalic', weight: 900, italic: true, instance: { wght: 900 } }, missing: false });
  expect(r.unknownPs).toMatchObject({ family: 'Myriad Pro', style: { postScriptName: 'MyriadPro-BoldIt', weight: 700, italic: true }, missing: true });
  expect(r.resolved).toMatchObject({ family: VF, postScriptName: 'SourceSans3VF-Bold', weight: 700, italic: false, missing: false, synthetic: { bold: false, italic: false } });
  expect(r.missing).toMatchObject({ missing: true, substitute: VF });
  expect(r.axes).toEqual([{ tag: 'wght', name: 'Weight', min: 200, max: 900, default: 200 }]);
  expect(errors).toEqual([]);
});

test('Add Fonts keeps the files; real styles from the options bar reach the runs and new text, one entry each', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 600, height: 300 });
  await ready(page);
  const added = await runAwait(page, 'type:add-fonts', { paths: ['/fixtures/fonts/LiberationSans-Regular.ttf', '/fixtures/fonts/LiberationSans-Bold.ttf', '/fixtures/fonts/Liberation-LICENSE.txt'] });
  expect(added.added).toEqual(['Liberation Sans']);
  expect(added.report.join('\n')).toMatch(/Liberation-LICENSE\.txt: not a font file/);
  // the report shows in a dialog; close it
  await page.locator('.dialog-buttons .btn').first().click();
  const kept = await page.evaluate(async () => {
    const app = window.pigmentApp;
    const { fontCatalog } = await import('/lib/type/api.js');
    const list = app.presets.list('fonts');
    const blob = await app.presets.readBlob('fonts', list[0].data.blob);
    return { names: list.map((p) => [p.name, p.data.postScriptName, /^font-[0-9a-f]{40}\.ttf$/.test(p.data.blob), p.data.classification]), blobBytes: blob?.length ?? 0, styles: fontCatalog().styles('Liberation Sans').map((s) => [s.name, s.postScriptName, s.weight]) };
  });
  expect(kept.names).toEqual([['Liberation Sans', 'LiberationSans', true, 'sans-serif'], ['Liberation Sans', 'LiberationSans-Bold', true, 'sans-serif']]);
  expect(kept.blobBytes).toBeGreaterThan(100000);
  expect(kept.styles).toEqual([['Regular', 'LiberationSans', 400], ['Bold', 'LiberationSans-Bold', 700]]);

  const id = await addText(page, { text: 'Real styles', char: { fontFamily: 'Liberation Sans' } });
  await expect.poll(() => engineOf(page, id)).toBe('harfbuzz');
  await runAwait(page, 'tool:text');
  const bar = page.locator('#options-bar');
  await expect(bar.locator('.opt[data-key="family"] .fp-field')).toHaveAttribute('data-value', 'Liberation Sans');
  const style = bar.locator('.opt[data-key="style"] select');
  await expect(style).toHaveValue('LiberationSans');
  expect(await style.locator('option').evaluateAll((os) => os.map((o) => [o.value, o.textContent]))).toEqual([['LiberationSans', 'Regular'], ['LiberationSans-Bold', 'Bold']]);
  const h0 = await historyLength(page);
  await style.selectOption('LiberationSans-Bold');
  await expect.poll(() => runsOf(page, id, ['postScriptName', 'fontWeight'])).toEqual([[11, { postScriptName: 'LiberationSans-Bold', fontWeight: 700 }]]);
  expect(await historyLength(page)).toBe(h0 + 1);
  expect(await page.evaluate(() => window.pigmentApp.doc.history.entries.at(-1).label)).toBe('Character');
  // drawn by the real bold face, not a synthesised one
  expect(await page.evaluate((lid) => window.pigmentApp.doc.find(lid).layout().lines[0].runs[0].face.postScriptName, id)).toBe('LiberationSans-Bold');
  // the family from the menu: typing into the field searches, Enter picks; the style becomes the family's nearest
  await bar.locator('.opt[data-key="family"] .fp-field').click();
  await page.locator('.fp-menu .fp-search').fill('sourcesans');
  await expect(page.locator('.fp-menu .fp-row[data-family="SourceSans3VF"]')).toBeVisible();
  await page.locator('.fp-menu .fp-search').press('Enter');
  await expect(page.locator('.fp-menu')).toHaveCount(0);
  await expect.poll(() => runsOf(page, id, ['fontFamily', 'postScriptName', 'fontWeight'])).toEqual([[11, { fontFamily: VF, postScriptName: 'SourceSans3VF-Bold', fontWeight: 700 }]]);
  await expect(style).toHaveValue('SourceSans3VF-Bold');
  expect(await historyLength(page)).toBe(h0 + 2);
  // undo restores Liberation Sans Bold
  await runAwait(page, 'edit:undo');
  await expect.poll(() => runsOf(page, id, ['fontFamily', 'postScriptName'])).toEqual([[11, { fontFamily: 'Liberation Sans', postScriptName: 'LiberationSans-Bold' }]]);
  // new text takes the options bar's face
  const fresh = await page.evaluate(async () => {
    const app = window.pigmentApp;
    // nothing targeted: a raster layer is active
    await app.commands.run('layer:new', undefined, 'api');
    app.tools.setOpt('type-horizontal', 'family', 'Liberation Sans', { silent: true });
    app.tools.setOpt('type-horizontal', 'style', 'LiberationSans-Bold', { silent: true });
    app.tools.active.beginNew({ x: 40, y: 200 }, null);
    const s = app.tools.active.session;
    const st = s.layer.content.runs[0].style;
    const out = { family: st.fontFamily, ps: st.postScriptName, weight: st.fontWeight };
    app.tools.active.cancelSession();
    return out;
  });
  expect(fresh).toEqual({ family: 'Liberation Sans', ps: 'LiberationSans-Bold', weight: 700 });
  expect(errors).toEqual([]);
});

test('a variable axis changes the layout from the Character panel; axes survive .pigment and undo', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 700, height: 300 });
  await ready(page);
  const id = await addText(page, { text: 'Weight axis', char: { fontFamily: VF, fontWeight: 400, size: 60 } });
  await expect.poll(() => engineOf(page, id)).toBe('harfbuzz');
  await runAwait(page, 'window:panel-character');
  const panel = page.locator('.panel.char-panel');
  await expect(panel.locator('[data-row="family"] .fp-field')).toHaveAttribute('data-value', VF);
  await expect(panel.locator('select[data-k="style"]')).toHaveValue('SourceSans3VF-Regular');
  const wght = panel.locator('.fp-axes .fp-axis[data-axis="wght"] .fp-axis-value');
  await expect(wght).toHaveValue('400');
  const w0 = await page.evaluate((lid) => window.pigmentApp.doc.find(lid).layout().width, id);
  const h0 = await historyLength(page);
  await wght.fill('820');
  await wght.dispatchEvent('change');
  await expect.poll(() => runsOf(page, id, ['axes', 'fontWeight'])).toEqual([[11, { axes: { wght: 820 }, fontWeight: 820 }]]);
  expect(await historyLength(page)).toBe(h0 + 1);
  const after = await page.evaluate((lid) => {
    const l = window.pigmentApp.doc.find(lid);
    const run = l.layout().lines[0].runs[0];
    return { width: l.layout().width, weight: run.face.weight, coords: run.face.coords };
  }, id);
  expect(after.weight).toBe(820);
  expect(after.coords).toEqual({ wght: 820 });
  expect(after.width).toBeGreaterThan(w0 + 10);
  // the style select shows the nearest instance with the custom value
  await expect(panel.locator('select[data-k="style"]')).toHaveValue('SourceSans3VF-Black|wght=820');
  // .pigment keeps the axes; the reopened layer lays out the same
  const back = await page.evaluate(async (lid) => {
    const io = await import('/lib/io.js');
    const d = window.pigmentApp.doc;
    const doc2 = await io.readPigment(await io.writePigment(d));
    const l2 = doc2.layers().find((l) => l.type === 'text');
    return { axes: l2.content.runs[0].style.axes, width: l2.layout().width, orig: d.find(lid).layout().width };
  }, id);
  expect(back.axes).toEqual({ wght: 820 });
  expect(back.width).toBeCloseTo(back.orig, 3);
  await runAwait(page, 'edit:undo');
  await expect.poll(() => runsOf(page, id, ['axes'])).toEqual([[11, { axes: null }]]);
  await expect(wght).toHaveValue('400');
  expect(errors).toEqual([]);
});

test('the font menu: WYSIWYG rows, classification filter, favourites, recents first; hovering previews without a history entry', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 600, height: 240 });
  await ready(page);
  const id = await addText(page, { text: 'Preview', char: { fontFamily: VF, size: 80 } });
  await expect.poll(() => engineOf(page, id)).toBe('harfbuzz');
  await runAwait(page, 'tool:text');
  const field = page.locator('#options-bar .opt[data-key="family"] .fp-field');
  await field.click();
  const menu = page.locator('.fp-menu');
  await expect(menu).toBeVisible();
  // the sample is drawn in the family's own face, at the preview size
  const row = menu.locator(`.fp-row[data-family="${VF}"]`);
  await expect(row).toBeVisible();
  const sample = await row.locator('.fp-sample').evaluate((s) => ({ family: s.style.fontFamily, size: s.style.fontSize, text: s.textContent }));
  expect(sample.family).toMatch(/pigment-face-\d+/);
  expect(sample).toMatchObject({ size: '15px', text: 'Sample' });
  // hover: the canvas shows the hovered family, with no history entry and no dirty mark
  const before = await page.evaluate(() => ({ h: window.pigmentApp.doc.history.index, dirty: window.pigmentApp.doc.history.dirty }));
  const sansRow = menu.locator('.fp-row[data-family="Arial"]');
  await menu.locator('.fp-search').fill('arial');
  await sansRow.hover();
  await expect.poll(() => page.evaluate(() => window.pigmentApp.fontPicker.preview.family)).toBe('Arial');
  const shown = await page.evaluate((lid) => {
    const l = window.pigmentApp.doc.find(lid);
    const out = l.render();
    return out.canvas.width;
  }, id);
  await menu.locator('.fp-search').press('Escape');
  await expect(menu).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.pigmentApp.fontPicker.preview.family)).toBe(null);
  const restored = await page.evaluate((lid) => window.pigmentApp.doc.find(lid).render().canvas.width, id);
  expect(shown).not.toBe(restored);
  expect(await page.evaluate(() => ({ h: window.pigmentApp.doc.history.index, dirty: window.pigmentApp.doc.history.dirty }))).toEqual(before);
  expect(await runsOf(page, id, ['fontFamily'])).toEqual([[7, { fontFamily: VF }]]);
  // classification filter and favourites
  await field.click();
  await menu.locator('.fp-class').selectOption('monospace');
  const monoRows = await menu.locator('.fp-row').evaluateAll((rs) => rs.map((r) => r.dataset.family));
  expect(monoRows.length).toBeGreaterThan(0);
  const classes = await page.evaluate(async (names) => {
    const { fontCatalog } = await import('/lib/type/api.js');
    return names.map((n) => fontCatalog().family(n).classification);
  }, monoRows);
  expect(new Set(classes)).toEqual(new Set(['monospace']));
  await menu.locator('.fp-class').selectOption('');
  await menu.locator('.fp-search').fill('Source');
  await menu.locator(`.fp-row[data-family="${VF}"] .fp-star`).click();
  await expect(menu.locator(`.fp-row[data-family="${VF}"] .fp-star`)).toHaveAttribute('aria-pressed', 'true');
  await menu.locator('.fp-search').fill('');
  await menu.locator('.fp-fav-filter').click();
  expect(await menu.locator('.fp-row').evaluateAll((rs) => rs.map((r) => r.dataset.family))).toEqual([VF]);
  // a click picks the family: it is listed first among the recents next time
  await menu.locator(`.fp-row[data-family="${VF}"]`).click();
  await field.click();
  // the menu opens scrolled to the current family: the recents are at the top
  await menu.locator('.fp-list').evaluate((l) => {
    l.scrollTop = 0;
    l.dispatchEvent(new Event('scroll'));
  });
  expect(await menu.locator('.fp-heading').first().textContent()).toBe('Recent');
  expect(await menu.locator('.fp-row').first().getAttribute('data-family')).toBe(VF);
  // Type > Font Preview Size reaches the rows and the menu state
  await runAwait(page, 'type:font-preview-size', 'huge');
  await expect.poll(() => menu.locator(`.fp-row[data-family="${VF}"] .fp-sample`).first().evaluate((s) => s.style.fontSize)).toBe('34px');
  expect(await page.evaluate(() => [window.pigmentApp.settings.typeFonts.previewSize, window.pigmentApp.uiState.fontPreviewSize])).toEqual(['huge', 'huge']);
  await runAwait(page, 'type:font-preview-size', 'none');
  await expect(menu.locator('.fp-sample')).toHaveCount(0);
  await page.keyboard.press('Escape');
  expect(errors).toEqual([]);
});

test('1000 families stay responsive: the list draws only the rows in view and filters fast', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  await ready(page);
  await page.evaluate(async () => {
    const { fontCatalog } = await import('/lib/type/api.js');
    const c = fontCatalog();
    for (let i = 0; i < 1000; i++) for (const st of ['Regular', 'Bold', 'Italic']) c.records.set(`Fake${i}-${st}`, { family: `Fake Family ${String(i).padStart(4, '0')}`, style: st, fullName: `Fake ${i} ${st}` });
    c.changed();
  });
  await runAwait(page, 'tool:text');
  const t = await page.evaluate(async () => {
    const t0 = performance.now();
    document.querySelector('#options-bar .opt[data-key="family"] .fp-field').click();
    const t1 = performance.now();
    const search = document.querySelector('.fp-menu .fp-search');
    search.value = 'family 09';
    search.dispatchEvent(new Event('input'));
    const t2 = performance.now();
    const { fontCatalog } = await import('/lib/type/api.js');
    return { open: t1 - t0, filter: t2 - t1, rows: document.querySelectorAll('.fp-menu .fp-row').length, total: fontCatalog().families().length, styles: fontCatalog().styles('Fake Family 0001').map((s) => s.postScriptName) };
  });
  expect(t.total).toBeGreaterThan(1000);
  expect(t.rows).toBeLessThan(60);
  expect(t.open).toBeLessThan(500);
  expect(t.filter).toBeLessThan(300);
  expect(t.styles).toEqual(['Fake1-Regular', 'Fake1-Italic', 'Fake1-Bold']);
  expect(await page.locator('.fp-menu .fp-count').textContent()).toBe('100 families');
  expect(errors).toEqual([]);
});

test('a missing font in an opened file is reported once, and in the Batch log, not as a dialog; Replace All and Manage replace it', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 400, height: 200, name: 'Missing' });
  await ready(page);
  await addText(page, { text: 'Lost font', char: { fontFamily: 'No Such Font Pro', postScriptName: 'NoSuchFontPro-Bold', fontWeight: 700 } });
  await page.evaluate(async () => {
    const io = await import('/lib/io.js');
    const T = window.__pigmentTest;
    const bytes = await io.writePigment(window.pigmentApp.doc);
    T.files['mem:/missing.pigment'] = bytes;
    T.files['mem:/batchfonts/a.pigment'] = bytes;
  });
  await runAwait(page, 'file:open-paths', ['mem:/missing.pigment']);
  await expect(page.locator('.toast', { hasText: 'missing: No Such Font Pro (NoSuchFontPro-Bold)' })).toHaveCount(1);
  await expect(page.locator('.dialog-backdrop')).toHaveCount(0);
  const m = await page.evaluate(async () => {
    const { fontCatalog } = await import('/lib/type/api.js');
    return fontCatalog().missing(window.pigmentApp.doc).map((x) => ({ family: x.family, ps: x.postScriptName, layers: x.layers.length }));
  });
  expect(m).toEqual([{ family: 'No Such Font Pro', ps: 'NoSuchFontPro-Bold', layers: 1 }]);
  // Batch: no dialog, no toast; a line in the log
  const batch = await page.evaluate(async () => {
    const app = window.pigmentApp;
    const T = window.__pigmentTest;
    const M = await import('/lib/actions/model.js');
    const set = M.makeSet('Fonts');
    set.actions.push(M.makeAction('Flip', [M.makeStep('image:flip-h')]));
    app.actions.sets.push(set);
    const missingToasts = () => [...document.querySelectorAll('.toast')].filter((t) => /missing/.test(t.textContent)).length;
    const toasts = missingToasts();
    const summary = await app.commands.run('file:automate-batch', { set: 'Fonts', action: 'Flip', source: 'folder', folder: 'mem:/batchfonts', destination: 'none', errors: 'log', logFile: 'mem:/fonts.log' }, 'api');
    await new Promise((r) => setTimeout(r, 0));
    return { processed: summary.processed, notes: summary.notes.map((n) => n.message), newToasts: missingToasts() - toasts, log: new TextDecoder().decode(T.written['mem:/fonts.log'] ?? new Uint8Array()) };
  });
  expect(batch.processed).toBe(1);
  expect(batch.notes).toEqual(['a.pigment: a font is missing: No Such Font Pro (NoSuchFontPro-Bold). The text uses a substitute until it is replaced.']);
  expect(batch.newToasts).toBe(0);
  expect(batch.log).toContain('No Such Font Pro');
  await expect(page.locator('.dialog-backdrop')).toHaveCount(0);
  // Replace All Missing Fonts: the bundled default, the run's weight kept, one entry that undoes
  await page.evaluate(() => window.pigmentApp.docs.activate(window.pigmentApp.docs.list().find((d) => d.path === 'mem:/missing.pigment')));
  const id = await page.evaluate(() => window.pigmentApp.doc.layers().find((l) => l.type === 'text').id);
  const h0 = await historyLength(page);
  await runAwait(page, 'type:replace-missing-fonts');
  await expect.poll(() => runsOf(page, id, ['fontFamily', 'postScriptName', 'fontWeight'])).toEqual([[9, { fontFamily: VF, postScriptName: null, fontWeight: 700 }]]);
  expect(await historyLength(page)).toBe(h0 + 1);
  expect(await page.evaluate(() => window.pigmentApp.doc.history.entries.at(-1).label)).toBe('Replace All Missing Fonts');
  expect(await page.evaluate(async () => (await import('/lib/type/api.js')).fontCatalog().missing(window.pigmentApp.doc).length)).toBe(0);
  await runAwait(page, 'edit:undo');
  await expect.poll(() => runsOf(page, id, ['fontFamily'])).toEqual([[9, { fontFamily: 'No Such Font Pro' }]]);
  // Manage Missing Fonts: the dialog lists the font with the default replacement in its weight; Replace applies it
  await run(page, 'type:manage-missing-fonts');
  const dialog = page.locator('.missing-fonts-dialog');
  await expect(dialog.locator('.mf-row .mf-name')).toHaveText('No Such Font Pro (NoSuchFontPro-Bold)');
  await expect(dialog.locator('.mf-row .fp-field')).toHaveAttribute('data-value', VF);
  await expect(dialog.locator('.mf-row .mf-style')).toHaveValue('SourceSans3VF-Bold');
  await dialog.locator('.mf-row .mf-style').selectOption('SourceSans3VF-Black');
  await dialog.locator('.dialog-buttons .btn.primary').click();
  await expect.poll(() => runsOf(page, id, ['fontFamily', 'postScriptName', 'fontWeight'])).toEqual([[9, { fontFamily: VF, postScriptName: 'SourceSans3VF-Black', fontWeight: 900 }]]);
  expect(await page.evaluate(() => window.pigmentApp.doc.history.entries.at(-1).label)).toBe('Resolve Missing Fonts');
  // the replay argument replaces without the dialog (action playback)
  await runAwait(page, 'edit:undo');
  await runAwait(page, 'type:manage-missing-fonts', { replacements: [{ family: 'No Such Font Pro', postScriptName: 'NoSuchFontPro-Bold', to: { fontFamily: VF, style: 'SourceSans3VF-Light' } }] });
  await expect.poll(() => runsOf(page, id, ['postScriptName', 'fontWeight'])).toEqual([[9, { postScriptName: 'SourceSans3VF-Light', fontWeight: 300 }]]);
  expect(errors).toEqual([]);
});

test('missing glyph protection: a character the font lacks is drawn by the bundled family, in a run of its own', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 500, height: 200 });
  await ready(page);
  await page.evaluate(async () => {
    const bytes = new Uint8Array(await (await fetch('/fixtures/fonts/Carlito-Regular.ttf')).arrayBuffer());
    return window.__pigmentTest.addFont(bytes, { family: 'Pigment Test Carlito' });
  });
  // U+2318 (⌘) is in Source Sans 3, not in Carlito
  const id = await addText(page, { text: 'Cmd ⌘ key', char: { fontFamily: 'Pigment Test Carlito', size: 60 } });
  await expect.poll(() => page.evaluate((lid) => {
    const lay = window.pigmentApp.doc.find(lid).layout();
    return lay.engine === 'harfbuzz' ? lay.lines[0].runs.map((r) => [r.from, r.to, r.face?.family ?? null, r.fallback?.family ?? null]) : null;
  }, id)).toEqual([[0, 4, 'Pigment Test Carlito', null], [4, 5, 'SourceSans3VF', 'SourceSans3VF'], [5, 9, 'Pigment Test Carlito', null]]);
  const ink = await page.evaluate((lid) => {
    const l = window.pigmentApp.doc.find(lid);
    const lay = l.layout();
    const run = lay.lines[0].runs[1];
    const out = l.renderBase();
    const x0 = Math.floor(run.x - out.x), x1 = Math.ceil(run.x + run.advance - out.x);
    const d = out.canvas.getContext('2d').getImageData(x0, 0, Math.max(1, x1 - x0), out.canvas.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 128) n++;
    return n;
  }, id);
  expect(ink).toBeGreaterThan(100);
  // the glyph is an outline: Create Work Path and optical kerning see it
  const outline = await page.evaluate(async () => {
    const { fonts } = await import('/lib/type/api.js');
    const M = await import('/lib/type/model.js');
    const p = fonts.outline(M.resolveChar({ fontFamily: 'Pigment Test Carlito', size: 60 }), '⌘');
    return p.subpaths.length;
  });
  expect(outline).toBeGreaterThan(0);
  // Preferences > Fonts switches the protection off: the character stays in its run, drawn by the browser's fallback
  const runsNow = () => page.evaluate((lid) => window.pigmentApp.doc.find(lid).layout().lines[0].runs.map((r) => [r.from, r.to, r.fallback?.family ?? null]), id);
  const setProtection = (on) => page.evaluate(async (v) => {
    const app = window.pigmentApp;
    const sec = app.preferences.sections().find((s) => s.id === 'type-fonts');
    const values = sec.read(app.settings);
    const patch = sec.write({ ...values, typeFontsGlyphProtection: v }, app.settings);
    try {
      await app.saveSettings(patch);
    } finally {
      await new Promise((r) => setTimeout(r, 0));
    }
    return { before: values.typeFontsGlyphProtection, stored: app.settings.typeFonts.glyphProtection };
  }, on);
  expect(await setProtection(false)).toEqual({ before: true, stored: false });
  await expect.poll(runsNow).toEqual([[0, 9, null]]);
  expect(await setProtection(true)).toEqual({ before: false, stored: true });
  await expect.poll(runsNow).toEqual([[0, 4, null], [4, 5, 'SourceSans3VF'], [5, 9, null]]);
  expect(errors).toEqual([]);
});

test('in a 16-bit Grayscale document the style list and an axis value reach the runs and draw', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 500, height: 200 });
  await ready(page);
  const id = await addText(page, { text: 'Deep gray', char: { fontFamily: VF, size: 60 } });
  await expect.poll(() => engineOf(page, id)).toBe('harfbuzz');
  await runAwait(page, 'image:mode', { mode: 'grayscale', silent: true, flatten: false });
  await runAwait(page, 'image:depth', 16);
  expect(await page.evaluate(() => [window.pigmentApp.doc.mode, window.pigmentApp.doc.depth])).toEqual(['grayscale', 16]);
  await page.evaluate((lid) => {
    const app = window.pigmentApp;
    app.doc.setActive(app.doc.find(lid));
    app.doc.changed('tree');
  }, id);
  await runAwait(page, 'tool:text');
  const style = page.locator('#options-bar .opt[data-key="style"] select');
  await expect(style).toHaveValue('SourceSans3VF-Regular');
  const w0 = await page.evaluate((lid) => window.pigmentApp.doc.find(lid).layout().width, id);
  await style.selectOption('SourceSans3VF-Black');
  await expect.poll(() => runsOf(page, id, ['postScriptName', 'fontWeight'])).toEqual([[9, { postScriptName: 'SourceSans3VF-Black', fontWeight: 900 }]]);
  const r = await page.evaluate(async (lid) => {
    const app = window.pigmentApp;
    const { applyChar } = await import('/lib/type/target.js');
    applyChar(app, { axes: { wght: 300 }, fontWeight: 300 });
    const l = app.doc.find(lid);
    const out = l.render();
    const d = out.canvas.getContext('2d').getImageData(0, 0, out.canvas.width, out.canvas.height).data;
    let ink = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 128) ink++;
    return { width: l.layout().width, face: l.layout().lines[0].runs[0].face.coords, ink };
  }, id);
  expect(r.face).toEqual({ wght: 300 });
  expect(r.width).toBeLessThan(w0);
  expect(r.ink).toBeGreaterThan(500);
  expect(errors).toEqual([]);
});
