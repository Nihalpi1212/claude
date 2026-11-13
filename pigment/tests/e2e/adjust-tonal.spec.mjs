// adjust-tonal (0.4 package 7): Levels, Curves and the tonal dialogs: eyedroppers and the on-image tool on the canvas
// while a dialog is open, presets (store and .alv files), the "last settings" commands, the Properties editor sampling
// the full-resolution composite, Equalize's selection question, the clipping display, pencil curves, Auto options.
import { test, expect } from '@playwright/test';
import { openApp, newDoc, runAwait, run, pixel, screenPoint, confirmDialog, historyLength } from './helpers.mjs';

/** A 400 x 300 document: a (200, 180, 160) strip on the left (x < 80), a ramp of greys elsewhere. */
async function testImage(page) {
  await newDoc(page, { width: 400, height: 300 });
  await page.evaluate(() => {
    const app = window.pigmentApp;
    const l = app.doc.active;
    const ctx = l.canvas.getContext('2d');
    const g = ctx.createLinearGradient(80, 0, 400, 0);
    g.addColorStop(0, '#404040');
    g.addColorStop(1, '#c0c0c0');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 400, 300);
    ctx.fillStyle = 'rgb(200, 180, 160)';
    ctx.fillRect(0, 0, 80, 300);
    l.touch();
    app.doc.changed('pixels', { layer: l });
  });
}

const dialog = '.dialog-backdrop .dialog';
const openLevels = async (page, cmd = 'image:adjust-levels') => {
  await run(page, cmd);
  await expect(page.locator(`${dialog} .levels-editor`)).toBeVisible();
};
const field = (page, key, scope = dialog) => page.locator(`${scope} input[type="number"][data-key="${key}"]`);
const setField = async (page, key, value, scope = dialog) => {
  await field(page, key, scope).fill(String(value));
  await field(page, key, scope).dispatchEvent('change');
};
const cancel = async (page) => {
  await page.keyboard.press('Escape');
  await expect(page.locator('.dialog-backdrop')).toHaveCount(0);
};
const clickDoc = async (page, x, y) => {
  const at = await screenPoint(page, x, y);
  await page.mouse.click(at.x, at.y);
};

test('Levels: the white eyedropper, then a click on the canvas while the dialog is open, sets the white point', async ({ page }) => {
  const errors = await openApp(page);
  await testImage(page);
  expect(await pixel(page, 20, 20)).toEqual([200, 180, 160, 255]);
  await openLevels(page);
  const white = page.locator(`${dialog} [data-eyedropper="white"]`);
  await white.click();
  await expect(white).toHaveAttribute('aria-pressed', 'true');
  await clickDoc(page, 20, 280); // inside the strip, away from the dialog box
  // the sample becomes white in the preview at once
  await expect.poll(() => pixel(page, 20, 20)).toEqual([255, 255, 255, 255]);
  // the other tool did not act on the click (no selection), and the dialog stays open
  expect(await page.evaluate(() => !!window.pigmentApp.doc.selection && !window.pigmentApp.doc.selection.isEmpty)).toBe(false);
  await expect(page.locator(dialog)).toBeVisible();
  // Escape puts the eyedropper down; a second Escape closes the dialog
  await page.keyboard.press('Escape');
  await expect(white).toHaveAttribute('aria-pressed', 'false');
  await confirmDialog(page);
  expect(await pixel(page, 20, 20)).toEqual([255, 255, 255, 255]);
  const last = await page.evaluate(() => window.pigmentApp.settings.adjustLast.levels);
  expect([last.r.inWhite, last.g.inWhite, last.b.inWhite]).toEqual([200, 180, 160]);
  expect(errors).toEqual([]);
});

test('Levels presets: save one, pick it in a new dialog, write it as .alv and load it back; "Custom" after an edit', async ({ page }) => {
  const errors = await openApp(page);
  await testImage(page);
  await openLevels(page);
  const select = page.locator(`${dialog} select[data-preset-kind="adjustment:levels"]`);
  await expect(select.locator('option', { hasText: 'Increase Contrast 2' })).toHaveCount(1);
  await setField(page, 'inBlack', 40);
  await setField(page, 'gamma', 1.25);
  await page.locator(`${dialog} .preset-more`).click();
  await page.locator(`${dialog} .preset-menu [data-act="save"]`).click();
  const prompt = page.locator('.dialog-backdrop').last();
  await prompt.locator('input').fill('Mine');
  await prompt.locator('.btn.primary').click();
  await expect(select).toHaveValue(/^u-/);
  // Save to File…: Photoshop's .alv
  await page.evaluate(() => (window.__pigmentTest.nextSavePath = '/presets/mine.alv'));
  await page.locator(`${dialog} .preset-more`).click();
  await page.locator(`${dialog} .preset-menu [data-act="export"]`).click();
  await expect.poll(() => page.evaluate(() => window.__pigmentTest.written['/presets/mine.alv']?.length ?? 0)).toBe(292);
  // an edit leaves the preset: the menu says Custom
  await setField(page, 'inWhite', 230);
  await expect(select).toHaveValue('');
  await cancel(page);

  // a new dialog opens with the defaults; picking the preset fills the fields
  await openLevels(page);
  await expect(field(page, 'inBlack')).toHaveValue('0');
  await select.selectOption({ label: 'Mine' });
  await expect(field(page, 'inBlack')).toHaveValue('40');
  await expect(field(page, 'gamma')).toHaveValue('1.25');
  // a built-in
  await select.selectOption({ label: 'Increase Contrast 3' });
  await expect(field(page, 'inBlack')).toHaveValue('30');
  // Load Preset… reads the .alv file (named after it) and picks it
  await page.evaluate(() => (window.__pigmentTest.nextOpenFiles = ['/presets/mine.alv']));
  await page.locator(`${dialog} .preset-more`).click();
  await page.locator(`${dialog} .preset-menu [data-act="load"]`).click();
  await expect(select.locator('option:checked')).toHaveText('mine');
  await expect(field(page, 'inBlack')).toHaveValue('40');
  await confirmDialog(page);
  // the presets live in the preset store (not in settings.json)
  const stored = await page.evaluate(async () => {
    await window.pigmentApp.presets.ready('adjustment:levels');
    return window.pigmentApp.presets.list('adjustment:levels').filter((p) => !p.builtin).map((p) => [p.name, p.data.rgb.inBlack]);
  });
  expect(stored).toEqual([['Mine', 40], ['mine', 40]]);
  // Delete Current Preset
  await openLevels(page);
  await select.selectOption({ label: 'Mine' });
  await page.locator(`${dialog} .preset-more`).click();
  await page.locator(`${dialog} .preset-menu [data-act="delete"]`).click();
  await page.locator('.dialog-backdrop').last().locator('.btn.primary').click();
  await expect(select.locator('option', { hasText: /^Mine$/ })).toHaveCount(0);
  await cancel(page);
  expect(errors).toEqual([]);
});

test('Alt+Ctrl+L reopens Levels with the last values; Ctrl+L opens it with the defaults; actions record the plain command', async ({ page }) => {
  const errors = await openApp(page);
  await testImage(page);
  await openLevels(page);
  await setField(page, 'inBlack', 30);
  await confirmDialog(page);
  await page.keyboard.press('Control+l');
  await expect(page.locator(`${dialog} .levels-editor`)).toBeVisible();
  await expect(field(page, 'inBlack')).toHaveValue('0');
  await cancel(page);
  await page.keyboard.press('Control+Alt+l');
  await expect(page.locator(`${dialog} .levels-editor`)).toBeVisible();
  await expect(field(page, 'inBlack')).toHaveValue('30');
  await cancel(page);
  // the four commands are real (not stubs) and enabled with a document
  const state = await page.evaluate(() => {
    const app = window.pigmentApp;
    return ['levels', 'curves', 'hue-saturation', 'color-balance'].map((k) => [app.stubbed.includes(`image:adjust-${k}-last`), app.commands.isEnabled(`image:adjust-${k}-last`)]);
  });
  expect(state).toEqual([[false, true], [false, true], [false, true], [false, true]]);
  // a replayed "last" command with values reports the plain command
  const done = await page.evaluate(async () => {
    const app = window.pigmentApp;
    let seen = null;
    const off = app.on('command:done', (e) => {
      if (e.id === 'image:adjust-levels-last') seen = [e.replayId ?? null, e.replayArg?.rgb?.inBlack ?? null];
    });
    await app.commands.run('image:adjust-levels-last', { rgb: { inBlack: 12, inWhite: 255, gamma: 1, outBlack: 0, outWhite: 255 } }, 'api');
    off();
    return seen;
  });
  expect(done).toEqual(['image:adjust-levels', 12]);
  expect(errors).toEqual([]);
});

test('Curves: the on-image tool adds a point at the clicked tone and a drag moves it; pencil mode and Smooth', async ({ page }) => {
  const errors = await openApp(page);
  await testImage(page);
  const before = await pixel(page, 390, 20);
  await run(page, 'image:adjust-curves');
  await expect(page.locator(`${dialog} .curves-editor`)).toBeVisible();
  await page.locator(`${dialog} [data-on-image]`).click();
  const at = await screenPoint(page, 390, 280); // right of the dialog box
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.mouse.move(at.x, at.y - 15, { steps: 3 });
  await page.mouse.move(at.x, at.y - 30, { steps: 3 });
  await page.mouse.up();
  await expect.poll(async () => (await pixel(page, 390, 20))[0]).toBeGreaterThan(before[0] + 10);
  await confirmDialog(page);
  const pts = await page.evaluate(() => window.pigmentApp.settings.adjustLast.curves.rgb);
  expect(pts.length).toBe(3);
  expect(pts[1][0]).toBe(before[0]); // the grey under the pointer
  expect(pts[1][1]).toBeGreaterThanOrEqual(before[0] + 25);

  // pencil: draw across the graph, Smooth, OK: a drawn curve ({ table })
  await run(page, 'image:adjust-curves');
  await page.locator(`${dialog} .curves-mode [data-mode="pencil"]`).click();
  const graph = page.locator(`${dialog} canvas.curve-editor`);
  const box = await graph.boundingBox();
  await page.mouse.move(box.x + 10, box.y + box.height - 10);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + 30, { steps: 8 });
  await page.mouse.move(box.x + box.width - 10, box.y + 10, { steps: 8 });
  await page.mouse.up();
  await page.locator(`${dialog} [data-act="smooth"]`).click();
  await confirmDialog(page);
  const drawn = await page.evaluate(() => window.pigmentApp.settings.adjustLast.curves.rgb);
  expect(Array.isArray(drawn.table) && drawn.table.length === 256).toBe(true);
  expect(drawn.table[128]).toBeGreaterThan(170);
  expect(errors).toEqual([]);
});

test('Properties: a Levels layer’s editor in the panel, its eyedropper sampling the full-resolution composite below', async ({ page }) => {
  const errors = await openApp(page);
  // wider than the 512 px histogram source: a 6 px stripe would be blurred there
  await newDoc(page, { width: 1400, height: 900 });
  await page.evaluate(() => {
    const app = window.pigmentApp;
    const l = app.doc.active;
    const ctx = l.canvas.getContext('2d');
    ctx.fillStyle = '#303030';
    ctx.fillRect(0, 0, 1400, 900);
    ctx.fillStyle = 'rgb(180, 170, 150)';
    ctx.fillRect(700, 0, 6, 900);
    l.touch();
    app.doc.changed('pixels', { layer: l });
  });
  await runAwait(page, 'layer:new-adjustment', 'levels');
  await page.evaluate(() => window.pigmentApp.panels.show('properties', { reveal: true }));
  const props = '[data-panel="properties"].panel';
  await expect(page.locator(`${props} .levels-editor`)).toBeVisible();
  await expect(page.locator(`${props} select[data-preset-kind="adjustment:levels"]`)).toBeVisible();
  const n = await historyLength(page);
  await page.locator(`${props} [data-eyedropper="white"]`).click();
  await clickDoc(page, 703, 450);
  await expect.poll(() => page.evaluate(() => window.pigmentApp.doc.active.params.r?.inWhite ?? null)).toBe(180);
  expect(await page.evaluate(() => [window.pigmentApp.doc.active.params.g.inWhite, window.pigmentApp.doc.active.params.b.inWhite])).toEqual([170, 150]);
  expect(await pixel(page, 703, 450)).toEqual([255, 255, 255, 255]);
  expect(await historyLength(page)).toBe(n + 1);
  // the panel's numeric field edits the layer too, and the eyedropper is put down when the tool changes
  await setField(page, 'outBlack', 20, props);
  await expect.poll(() => page.evaluate(() => window.pigmentApp.doc.active.params.rgb.outBlack)).toBe(20);
  await page.locator(`${props} [data-eyedropper="black"]`).click();
  await page.evaluate(() => window.pigmentApp.tools.activate('brush'));
  await expect(page.locator(`${props} [data-eyedropper="black"]`)).toHaveAttribute('aria-pressed', 'false');
  expect(errors).toEqual([]);
});

test('Equalize asks about the selection: the selected area only, or the entire image based on it', async ({ page }) => {
  const errors = await openApp(page);
  await testImage(page);
  const outside = await pixel(page, 300, 150);
  await page.evaluate(async () => {
    const { Selection } = await import('/lib/selection.js');
    const d = window.pigmentApp.doc;
    d.selection = Selection.fromRect(d.width, d.height, { x: 100, y: 100, width: 60, height: 60 });
    d.changed('selection');
  });
  await run(page, 'image:adjust-equalize');
  await expect(page.locator(`${dialog}`)).toContainText('Entire image based on selected area');
  await page.locator(`${dialog} .seg-button[data-value="selection"]`).click();
  await confirmDialog(page);
  expect(await pixel(page, 300, 150)).toEqual(outside); // only the selection changed
  await runAwait(page, 'edit:undo');
  await run(page, 'image:adjust-equalize');
  await page.locator(`${dialog} .seg-button[data-value="image"]`).click();
  await confirmDialog(page);
  // the dark selected greys spread over the whole range: the lighter rest of the image goes to white
  await expect.poll(() => pixel(page, 300, 150)).toEqual([255, 255, 255, 255]);
  expect(errors).toEqual([]);
});

test('Levels: Alt-dragging the black input slider shows the clipping display; Auto Options saved as defaults', async ({ page }) => {
  const errors = await openApp(page);
  await testImage(page);
  await openLevels(page);
  const knob = page.locator(`${dialog} .tonal-track-input [data-handle="inBlack"]`);
  const kb = await knob.boundingBox();
  const track = await page.locator(`${dialog} .tonal-track-input`).boundingBox();
  await page.keyboard.down('Alt');
  await page.mouse.move(kb.x + kb.width / 2, kb.y + kb.height / 2);
  await page.mouse.down();
  // to about 100 (0.39 of the track): the dark ramp start (0x40) clips, the light strip does not
  await page.mouse.move(track.x + track.width * 0.39, kb.y + kb.height / 2, { steps: 6 });
  await expect.poll(() => pixel(page, 85, 150)).toEqual([0, 0, 0, 255]);
  expect(await pixel(page, 20, 150)).toEqual([255, 255, 255, 255]);
  await page.mouse.up();
  await page.keyboard.up('Alt');
  // released: the normal preview again
  await expect.poll(async () => (await pixel(page, 20, 150))[0]).toBeLessThan(255);
  expect(Number(await field(page, 'inBlack').inputValue())).toBeGreaterThan(80);
  await cancel(page);

  // Alt-click Auto: Auto Color Correction Options; Save as defaults writes settings.adjust.autoOptions
  await openLevels(page);
  await page.locator(`${dialog} [data-act="auto"]`).click({ modifiers: ['Alt'] });
  const opts = page.locator('.dialog-backdrop').last();
  await expect(opts).toContainText('Auto Color Correction Options');
  await opts.locator('select[data-key="algorithm"]').selectOption('mono');
  await opts.locator('input[data-key="saveDefaults"]').check();
  await opts.locator('.btn.primary').click();
  await expect.poll(() => page.evaluate(() => window.pigmentApp.settings.adjust?.autoOptions?.algorithm ?? null)).toBe('mono');
  // the image's darkest grey (0x40, about 64) becomes the black point of the composite
  await expect.poll(async () => Number(await field(page, 'inBlack').inputValue())).toBeGreaterThan(55);
  await confirmDialog(page);
  expect(errors).toEqual([]);
});
