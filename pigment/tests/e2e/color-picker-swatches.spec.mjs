// color-picker-swatches (ARCHITECTURE.md "0.5 features", package 11; port 8861): the colour picker (axes, fields, Lab
// through icc-engine, warnings, Only Web Colors, sampling the image and the screen, Color Libraries with .acb books),
// the real `color` widget at every call site, the HUD colour picker driven through brush-painting-behaviours' gesture,
// the Color panel's views, the Swatches panel on the `swatches` kind (migration, groups, search, import), the
// Eyedropper's Sample Size and Sample choices, Copy Color as Hex / HTML. The five paths (rule 13): no colour choice is a
// history entry (the HUD and the panels set the foreground as 0.4's Color panel did); Grayscale and Display P3
// documents; swatches survive a reload through the preset store.
import { test, expect } from '@playwright/test';
import { openApp, newDoc, run, runAwait, pixel, confirmDialog, screenPoint } from './helpers.mjs';

const picker = (page) => page.locator('.color-picker-dialog').last();

/** Opens the picker from the page (no await on the app promise in the evaluate) and returns nothing. */
async function openPicker(page, opts) {
  await page.evaluate((o) => {
    window.__picked = undefined;
    window.pigmentApp.colorPicker.pick(o).then((v) => (window.__picked = v));
  }, opts);
  await expect(picker(page)).toBeVisible();
}
const picked = (page) => page.waitForFunction(() => window.__picked !== undefined).then(() => page.evaluate(() => window.__picked));

async function typeField(page, sel, value) {
  const f = picker(page).locator(sel);
  await f.fill(String(value));
  await f.blur();
}

test('the picker: real, nine axes with their radio buttons, HSB / RGB / hex / Lab (icc-engine D50) / CMYK fields, the ColorValue of each model', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  expect(await page.evaluate(() => window.pigmentApp.colorPicker.real)).toBe(true);
  await openPicker(page, { initial: '#ff0000', title: 'Pick' });
  const dlg = picker(page);
  await expect(dlg.locator('.dialog-header')).toContainText('Pick');
  await expect(dlg.locator('[data-axis]')).toHaveCount(9);
  await expect(dlg.locator('[data-f="hex"]')).toHaveValue('ff0000');
  await expect(dlg.locator('[data-m="m"]')).toHaveValue('100');
  // Lab goes through the pipeline: D50 Lab of the untagged document once icc-engine is ready, 0.4's D65 without it
  const lab = await page.evaluate(async () => {
    const { toLab } = await import('/lib/color/pipeline.js');
    return toLab([255, 0, 0], null).map(Math.round);
  });
  await expect(dlg.locator('[data-m="L"]')).toHaveValue(String(lab[0]));
  await expect(dlg.locator('[data-m="a"]')).toHaveValue(String(lab[1]));
  // an axis button changes the field and is remembered
  await dlg.locator('[data-axis="r"]').check();
  await expect.poll(() => page.evaluate(() => window.pigmentApp.settings.colorUI.pickerAxis)).toBe('r');
  // a click in the R field: blue across, green down (top-right: blue 255, green 255, red kept)
  // (a drag past the corner: the pointer is captured, the position clamped)
  const box = await dlg.locator('.cpx-field').boundingBox();
  await page.mouse.move(box.x + box.width - 5, box.y + 5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width + 30, box.y - 30, { steps: 3 });
  await page.mouse.up();
  await expect(dlg.locator('[data-f="hex"]')).toHaveValue('ffffff');
  // the strip: the bottom is red 0
  const sbox = await dlg.locator('.cpx-strip').boundingBox();
  await page.mouse.move(sbox.x + sbox.width / 2, sbox.y + sbox.height - 5);
  await page.mouse.down();
  await page.mouse.move(sbox.x + sbox.width / 2, sbox.y + sbox.height + 30, { steps: 3 });
  await page.mouse.up();
  await expect(dlg.locator('[data-f="hex"]')).toHaveValue('00ffff');
  // the fields: hex, then HSB
  await typeField(page, '[data-f="hex"]', '336699');
  await expect(dlg.locator('[data-f="r"]')).toHaveValue('51');
  await expect(dlg.locator('[data-f="h"]')).toHaveValue('210');
  await typeField(page, '[data-f="v"]', '100');
  await expect(dlg.locator('[data-f="hex"]')).toHaveValue('55aaff');
  await dlg.locator('.dialog-buttons .btn.primary').click();
  expect(await picked(page)).toEqual({ hex: '#55aaff', rgb: [85, 170, 255], book: null, space: 'hsb' });

  // Lab typed: the ColorValue keeps the Lab numbers, the RGB is fromLab's
  await openPicker(page, { initial: '#000000' });
  await typeField(page, '[data-m="L"]', 50);
  await typeField(page, '[data-m="a"]', 20);
  await typeField(page, '[data-m="b"]', -30);
  const want = await page.evaluate(async () => {
    const { fromLab } = await import('/lib/color/pipeline.js');
    return fromLab([50, 20, -30], null);
  });
  await picker(page).locator('.dialog-buttons .btn.primary').click();
  const v = await picked(page);
  expect(v.space).toBe('lab');
  expect(v.lab).toEqual([50, 20, -30]);
  expect(v.rgb).toEqual(want);
  // CMYK typed: 0.3's model, the CMYK numbers kept
  await openPicker(page, { initial: '#ffffff' });
  await typeField(page, '[data-m="c"]', 100);
  await expect(picker(page).locator('[data-f="hex"]')).toHaveValue('00ffff');
  await picker(page).locator('.dialog-buttons .btn.primary').click();
  expect(await picked(page)).toMatchObject({ hex: '#00ffff', cmyk: [100, 0, 0, 0], space: 'cmyk' });
  // Cancel resolves null; the 0.4 hex API stays
  await page.evaluate(() => {
    window.__hex = undefined;
    window.pigmentApp.pickColor('#123456').then((h) => (window.__hex = h));
  });
  await expect(picker(page).locator('[data-f="hex"]')).toHaveValue('123456');
  await picker(page).locator('.dialog-buttons .btn:not(.primary)').click();
  await page.waitForFunction(() => window.__hex !== undefined);
  expect(await page.evaluate(() => window.__hex)).toBe(null);
  expect(errors).toEqual([]);
});

test('the picker: Only Web Colors, the web and printing warnings, a Lab colour the profile cannot hold, a Display P3 document\'s Lab', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  await openPicker(page, { initial: '#123456' });
  const dlg = picker(page);
  // not web-safe: the cube warns, a click takes the closest web colour
  await expect(dlg.locator('.cp-web')).toBeVisible();
  await dlg.locator('.cp-web').click();
  await expect(dlg.locator('[data-f="hex"]')).toHaveValue('003366');
  await expect(dlg.locator('.cp-web')).toBeHidden();
  // Only Web Colors: whatever is typed snaps, and the setting stays
  await dlg.locator('[data-k="webOnly"]').check();
  await typeField(page, '[data-f="hex"]', '8a1f3c');
  await expect(dlg.locator('[data-f="hex"]')).toHaveValue('993333');
  await dlg.locator('[data-k="webOnly"]').uncheck();
  expect(await page.evaluate(() => window.pigmentApp.settings.colorUI.webOnly)).toBe(false);
  // out of gamut for printing (View > Gamut Warning's test): a click takes the printable colour
  const out = await page.evaluate(async () => {
    const C = await import('/shared/pixels/color.js');
    for (const hex of ['#00ff00', '#0000ff', '#ff00ff', '#00ffff', '#ff0000']) {
      const rgb = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
      if (C.isOutOfCmykGamut(rgb)) return hex;
    }
    return null;
  });
  expect(out).not.toBe(null);
  await typeField(page, '[data-f="hex"]', out.slice(1));
  await expect(dlg.locator('.cp-gamut')).toBeVisible();
  await dlg.locator('.cp-gamut').click();
  await expect(dlg.locator('.cp-gamut')).toBeHidden();
  expect(await dlg.locator('[data-f="hex"]').inputValue()).not.toBe(out.slice(1));
  // a Lab colour outside the document's RGB: the note says so
  await typeField(page, '[data-m="L"]', 60);
  await typeField(page, '[data-m="a"]', 120);
  await typeField(page, '[data-m="b"]', -120);
  await expect(dlg.locator('.cp-note')).toBeVisible();
  await dlg.locator('.dialog-buttons .btn:not(.primary)').click();

  // a Display P3 document (icc-engine): the picker's Lab is that profile's
  const p3 = await page.evaluate(async () => {
    const P = await import('/lib/color/pipeline.js');
    const app = window.pigmentApp;
    const prof = P.profileById('display-p3');
    if (!prof || !P.colorEngine().available) return null;
    P.assignProfile(app, app.doc, prof);
    return { srgb: P.toLab([255, 0, 0], null).map(Math.round), p3: P.toLab([255, 0, 0], prof).map(Math.round) };
  });
  if (p3) {
    expect(p3.p3).not.toEqual(p3.srgb);
    await openPicker(page, { initial: '#ff0000' });
    await expect(picker(page).locator('[data-m="L"]')).toHaveValue(String(p3.p3[0]));
    await expect(picker(page).locator('[data-m="a"]')).toHaveValue(String(p3.p3[1]));
    await picker(page).locator('.dialog-buttons .btn:not(.primary)').click();
  }
  expect(errors).toEqual([]);
});

test('the picker samples the image under it (the Eyedropper\'s Sample Size) and the screen (EyeDropper, from sRGB)', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 200, height: 150 });
  await page.evaluate(() => {
    const l = window.pigmentApp.doc.active;
    const ctx = l.canvas.getContext('2d');
    ctx.fillStyle = '#20a040';
    ctx.fillRect(0, 0, 100, 150);
    l.touch();
    window.pigmentApp.doc.changed('pixels', { layer: l });
    // a fake screen eyedropper (the real one needs a person to click)
    window.EyeDropper = class {
      open() {
        return Promise.resolve({ sRGBHex: '#c08040' });
      }
    };
  });
  await runAwait(page, 'view:zoom-fit');
  const hist = await page.evaluate(() => window.pigmentApp.doc.history.index);
  await openPicker(page, { initial: '#000000', target: 'foreground' });
  const dlg = picker(page);
  await expect(dlg.locator('.cp-sample-hint')).toBeVisible();
  // a click on the image beside the dialog
  const at = await screenPoint(page, 20, 20);
  await page.mouse.click(at.x, at.y);
  await expect(dlg.locator('[data-f="hex"]')).toHaveValue('20a040');
  // Sample Screen: the sRGB colour, converted into the (untagged) document's numbers
  await dlg.locator('.cp-screen').click();
  await expect(dlg.locator('[data-f="hex"]')).toHaveValue('c08040');
  await dlg.locator('.dialog-buttons .btn.primary').click();
  expect((await picked(page)).hex).toBe('#c08040');
  // nothing was painted and no history entry was made
  expect(await pixel(page, 20, 20)).toEqual([32, 160, 64, 255]);
  expect(await page.evaluate(() => window.pigmentApp.doc.history.index)).toBe(hist);
  expect(errors).toEqual([]);
});

test('every colour field opens the picker: a dialog form, the options bar, the Character panel, the shape popover; Cancel puts the live colour back', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  // a form field: the chip opens the picker, OK writes the field; the hidden input still sets it (S7.3)
  await page.evaluate(async () => {
    const { formDialog } = await import('/lib/form.js');
    window.__form = undefined;
    formDialog(window.pigmentApp, { title: 'Colours', fields: [{ key: 'tint', label: 'Tint', type: 'color', value: '#336699' }] }).then((v) => (window.__form = v));
  });
  const form = page.locator('.dialog').filter({ hasText: 'Colours' });
  await expect(form.locator('input[type="color"][data-key="tint"]')).toHaveValue('#336699');
  await form.locator('.color-chip').click();
  await expect(picker(page)).toBeVisible();
  await expect(picker(page).locator('[data-f="hex"]')).toHaveValue('336699');
  await typeField(page, '[data-f="hex"]', 'ff8800');
  // live: the field follows while the picker is open
  await expect(form.locator('.slider-field .input')).toHaveValue('#ff8800');
  await picker(page).locator('.dialog-buttons .btn:not(.primary)').click();
  await expect(form.locator('.slider-field .input')).toHaveValue('#336699');
  await form.locator('.color-chip').click();
  await typeField(page, '[data-f="hex"]', '00ff00');
  await picker(page).locator('.dialog-buttons .btn.primary').click();
  await expect(picker(page)).toHaveCount(0);
  await form.locator('input[type="color"][data-key="tint"]').evaluate((i) => {
    i.value = '#0000ff';
    i.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await confirmDialog(page);
  await page.waitForFunction(() => window.__form !== undefined);
  expect(await page.evaluate(() => window.__form)).toEqual({ tint: '#0000ff' });

  // the options bar: the Type tool's colour
  await page.evaluate(() => window.pigmentApp.tools.activate('type-horizontal'));
  const chip = page.locator('#options-bar .color-chip').first();
  await chip.click();
  await expect(picker(page)).toBeVisible();
  await typeField(page, '[data-f="hex"]', 'aa0011');
  await picker(page).locator('.dialog-buttons .btn.primary').click();
  await expect.poll(() => page.evaluate(() => window.pigmentApp.settings.tools?.['type-horizontal']?.color ?? window.pigmentApp.tools.active.opt('color'))).toBe('#aa0011');

  // the Character panel's text colour and stroke colour are pickers too
  const n = await page.evaluate(async () => {
    const { createCharacterControls } = await import('/lib/type/char-format.js');
    const c = createCharacterControls(window.pigmentApp, { variant: 'panel' });
    const out = { chips: c.element.querySelectorAll('.color-chip').length, inputs: [...c.element.querySelectorAll('input[type="color"]')].map((i) => i.dataset.k) };
    c.destroy?.();
    return out;
  });
  expect(n).toEqual({ chips: 2, inputs: ['color', 'strokeColor'] });

  // the shape popover: its solid colour is a picker, its swatch row follows the `swatches` kind
  const row = await page.evaluate(async () => {
    const app = window.pigmentApp;
    await app.presets.ready('swatches');
    const { swatchColors } = await import('/lib/color-picker.js');
    const { paintPanel } = await import('/lib/shape-paint-ui.js');
    const p0 = app.presets.add('swatches', { name: 'Odd', data: { color: { space: 'rgb', values: [1, 2, 3] } } });
    app.presets.move('swatches', p0.id, { group: null, index: 0 }); // the row shows the first 60
    const panel = paintPanel(app, { value: { type: 'solid', color: '#ff0000' } });
    const r = { row: [...panel.element.querySelectorAll('.sl-swatches .sl-color')].map((b) => b.dataset.color), kind: swatchColors(app).slice(0, 60), chip: !!panel.element.querySelector('.color-chip') };
    panel.destroy?.();
    app.presets.remove('swatches', [p0.id]);
    return r;
  });
  expect(row.chip).toBe(true);
  expect(row.row).toEqual(row.kind);
  expect(row.kind).toContain('#010203');
  expect(errors).toEqual([]);
});

test('the HUD colour picker through the Brush\'s Alt+Shift+right-drag: live foreground, recent colour on release, Escape restores, no history entry', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 300, height: 200 });
  await runAwait(page, 'view:zoom-fit');
  await page.evaluate(() => {
    const app = window.pigmentApp;
    app.tools.activate('brush');
    app.setColors({ foreground: '#ff0000' });
    app.saveSettingsSoon({ recentColors: [] });
  });
  const real = await page.evaluate(async () => (await import('/lib/tools/paint-gesture.js')).PaintGesture.real === true);
  test.skip(!real, 'brush-painting-behaviours has not landed: the gesture that opens the HUD is a stub');
  const before = await page.evaluate(() => window.pigmentApp.doc.history.index);
  const a = await screenPoint(page, 150, 100);
  await page.mouse.move(a.x, a.y);
  await page.keyboard.down('Alt');
  await page.keyboard.down('Shift');
  await page.mouse.down({ button: 'right' });
  await expect(page.locator('.hud-picker')).toBeVisible();
  // left and down in the square: less saturation and brightness, the same hue
  await page.mouse.move(a.x - 40, a.y + 40, { steps: 4 });
  const live = await page.evaluate(() => window.pigmentApp.settings.foreground);
  expect(live).not.toBe('#ff0000');
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(live.slice(i, i + 2), 16));
  expect(r).toBeGreaterThan(g);
  expect(g).toBe(b);
  await page.mouse.up({ button: 'right' });
  await page.keyboard.up('Shift');
  await page.keyboard.up('Alt');
  await expect(page.locator('.hud-picker')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.pigmentApp.settings.recentColors[0])).toBe(live);
  expect(await page.evaluate(() => window.pigmentApp.settings.foreground)).toBe(live);
  // into the hue strip: the hue changes; Escape mid-drag puts the colour back
  await page.mouse.move(a.x, a.y);
  await page.keyboard.down('Alt');
  await page.keyboard.down('Shift');
  await page.mouse.down({ button: 'right' });
  const box = await page.locator('.hud-picker canvas').boundingBox();
  await page.mouse.move(box.x + box.width - 6, box.y + box.height * 0.6, { steps: 4 });
  await expect(page.locator('.hud-picker')).toHaveAttribute('data-zone', 'hue');
  expect(await page.evaluate(() => window.pigmentApp.settings.foreground)).not.toBe(live);
  await page.keyboard.press('Escape');
  await expect(page.locator('.hud-picker')).toHaveCount(0);
  await page.mouse.up({ button: 'right' });
  await page.keyboard.up('Shift');
  await page.keyboard.up('Alt');
  expect(await page.evaluate(() => window.pigmentApp.settings.foreground)).toBe(live);
  // no stroke was painted and the HUD made no history entry
  expect(await page.evaluate(() => window.pigmentApp.doc.history.index)).toBe(before);
  expect(await pixel(page, 150, 100)).toEqual([255, 255, 255, 255]);
  // the Hue Wheel style (Preferences > Color Picker)
  await page.evaluate(() => window.pigmentApp.saveSettingsSoon({ colorUI: { ...window.pigmentApp.settings.colorUI, hud: 'hue-wheel-small' } }));
  const wheel = await page.evaluate(async () => {
    const app = window.pigmentApp;
    const s = app.colorPicker.hud({ at: { x: 400, y: 300 }, tool: app.tools.active, initial: '#00ff00' });
    const m = s.model;
    const c = m.center;
    const o = s.element.getBoundingClientRect();
    s.move({ clientX: o.left + c.x, clientY: o.top + c.y - (m.ring.inner + m.ring.outer) / 2 });
    s.up({ clientX: o.left + c.x, clientY: o.top + c.y - (m.ring.inner + m.ring.outer) / 2 });
    return { layout: m.layout, value: await s.done };
  });
  expect(wheel.layout).toBe('wheel');
  expect(wheel.value.hex).toBe('#ff0000'); // the top of the ring is red, with the green's full saturation and brightness
  expect(errors).toEqual([]);
});

test('Swatches: 0.4\'s palette migrates once into the kind; add, rename, groups, move, search, delete; click and Alt-click; import .ase keeps groups', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  // migration: 0.4's edited palette replaces the built-ins, in order, once
  const mig = await page.evaluate(async () => {
    const app = window.pigmentApp;
    const CP = await import('/lib/color-picker.js');
    await app.presets.ready('swatches');
    app.settings.swatches = ['#123456', { color: '#abcdef', name: 'Sky' }];
    app.settings.swatchesEdited = true;
    app.settings.colorUI = { ...app.settings.colorUI, swatchesMigrated: false };
    const moved = await CP.migrateSwatches(app);
    const again = await CP.migrateSwatches(app);
    return { moved, again, list: app.presets.list('swatches').map((p) => [p.name, p.data.color.values]), colors: CP.swatchColors(app), flag: app.settings.colorUI.swatchesMigrated };
  });
  expect(mig).toEqual({ moved: true, again: false, list: [['#123456', [18, 52, 86]], ['Sky', [171, 205, 239]]], colors: ['#123456', '#abcdef'], flag: true });
  await runAwait(page, 'window:panel-swatches');
  const panel = page.locator('.swatches-panel');
  await expect(panel.locator('.swatch-main .swatch[data-id]')).toHaveCount(2);
  // click: foreground; Alt-click: background
  await panel.locator('.swatch[data-color="#abcdef"]').click();
  expect(await page.evaluate(() => window.pigmentApp.settings.foreground)).toBe('#abcdef');
  await panel.locator('.swatch[data-color="#123456"]').click({ modifiers: ['Alt'] });
  expect(await page.evaluate(() => window.pigmentApp.settings.background)).toBe('#123456');
  // + adds the foreground
  await page.evaluate(() => window.pigmentApp.setColors({ foreground: '#ff8800' }));
  await panel.locator('[data-act="add"]').click();
  await expect(panel.locator('.swatch-main .swatch[data-id]')).toHaveCount(3);
  // rename by double-click
  await panel.locator('.swatch[data-id][data-color="#ff8800"]').dblclick();
  await page.locator('.dialog input').last().fill('Orange');
  await confirmDialog(page);
  await expect.poll(() => page.evaluate(() => window.pigmentApp.presets.list('swatches').map((p) => p.name))).toEqual(['#123456', 'Sky', 'Orange']);
  // a new group takes the selected swatch
  await panel.locator('.swatch[data-id][data-color="#ff8800"]').click();
  await panel.locator('[data-act="group"]').click();
  await page.locator('.dialog input').last().fill('Warm');
  await confirmDialog(page);
  const group = panel.locator('.swatch-group').filter({ hasText: 'Warm' });
  await expect(group.locator('.swatch[data-id]')).toHaveCount(1);
  // the context menu moves Sky into the group
  await panel.locator('.swatch[data-id][data-color="#abcdef"]').click({ button: 'right' });
  await page.locator('.popover .popover-item, .popover button, .popover [role="menuitem"]').filter({ hasText: 'Move to Warm' }).first().click();
  await expect(group.locator('.swatch[data-id]')).toHaveCount(2);
  // collapse the group; search opens what matches
  await group.locator('.swatch-group-head').click();
  await expect(group.locator('.swatch[data-id]')).toHaveCount(0);
  await panel.locator('[data-k="swatch-search"]').fill('sky');
  await expect(panel.locator('.swatch[data-id]')).toHaveCount(1);
  await expect(panel.locator('.swatch[data-id]')).toHaveAttribute('data-color', '#abcdef');
  await panel.locator('[data-k="swatch-search"]').fill('#1234');
  await expect(panel.locator('.swatch[data-id]')).toHaveCount(1);
  await panel.locator('[data-k="swatch-search"]').fill('');
  await group.locator('.swatch-group-head').click();
  // delete the selected swatch
  await panel.locator('.swatch[data-id][data-color="#123456"]').click();
  await panel.locator('[data-act="delete"]').click();
  await expect.poll(() => page.evaluate(() => window.pigmentApp.presets.list('swatches').map((p) => p.name).sort())).toEqual(['Orange', 'Sky']);
  // an .ase file imports into the kind, its groups kept (preset-files-manager's reader)
  const imp = await page.evaluate(async () => {
    const app = window.pigmentApp;
    const { writeAse } = await import('/lib/preset-files/aco-ase.js');
    const { importPresetBytes } = await import('/lib/preset-formats.js');
    const { bytes } = writeAse({ groups: [{ name: 'Sea', colors: [{ name: 'Deep', color: { space: 'rgb', values: [0, 40, 90] }, type: 'global' }] }], colors: [{ name: 'Sand', color: { space: 'lab', values: [80, 5, 20] }, type: 'spot' }] });
    const res = await importPresetBytes(app, [{ name: 'Beach.ase', bytes }], { kinds: ['swatches'] });
    return { added: res.added, groups: app.presets.groups('swatches').map((g) => g.name), sand: app.presets.list('swatches').find((p) => p.name === 'Sand')?.data };
  });
  expect(imp.added).toEqual({ swatches: 2 });
  expect(imp.groups).toEqual(expect.arrayContaining(['Warm', 'Beach', 'Sea']));
  expect(imp.sand).toEqual({ color: { space: 'lab', values: [80, 5, 20] }, type: 'spot' });
  await expect(panel.locator('.swatch-group:has(> .swatch-group-head:has-text("Sea")) > .swatch-grid .swatch[data-id]')).toHaveAttribute('data-color', '#00285a');
  expect(errors).toEqual([]);
});

test('Copy Color as Hex / HTML from the Eyedropper\'s context menu, a swatch and the Color panel menu; the Eyedropper\'s sample sizes', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 200, height: 100 });
  await runAwait(page, 'view:zoom-fit');
  await page.evaluate(() => {
    const app = window.pigmentApp;
    const l = app.doc.active;
    const ctx = l.canvas.getContext('2d');
    // a 2 x 2 checker of red and blue at (50, 50): a point sample sees one, an average both
    ctx.fillStyle = '#ff0000';
    ctx.fillRect(0, 0, 200, 100);
    ctx.fillStyle = '#0000ff';
    ctx.fillRect(50, 50, 1, 1);
    ctx.fillRect(51, 51, 1, 1);
    l.touch();
    app.doc.changed('pixels', { layer: l });
    app.tools.activate('eyedropper');
  });
  const sample = (size) => page.evaluate((n) => {
    const t = window.pigmentApp.tools.get('eyedropper');
    t.setOpt('sample', n);
    return t.sampleColor({ x: 50.5, y: 50.5 }).slice(0, 3).map(Math.round);
  }, size);
  expect(await sample('1')).toEqual([0, 0, 255]);
  expect(await sample('3')).toEqual([198, 0, 57]); // 7 red, 2 blue of 9
  expect(await page.evaluate(() => window.pigmentApp.tools.get('eyedropper').options.find((o) => o.key === 'sample').options.map((o) => o[0]))).toEqual(['1', '3', '5', '11', '31', '51', '101']);
  // right-click: the sizes and the two copies of the foreground
  await page.evaluate(() => window.pigmentApp.setColors({ foreground: '#ff8800' }));
  const at = await screenPoint(page, 100, 30);
  await page.mouse.click(at.x, at.y, { button: 'right' });
  const pop = page.locator('.popover').last();
  await expect(pop).toContainText('11 by 11 Average');
  await pop.getByText('Copy Color as HTML').click();
  await expect.poll(() => page.evaluate(() => window.__pigmentTest.clipboardText)).toBe('COLOR="#ff8800"');
  await page.mouse.click(at.x, at.y, { button: 'right' });
  await page.locator('.popover').last().getByText('Copy Color\'s Hex Code').click();
  await expect.poll(() => page.evaluate(() => window.__pigmentTest.clipboardText)).toBe('ff8800');
  // the right-click sampled nothing
  expect(await page.evaluate(() => window.pigmentApp.settings.foreground)).toBe('#ff8800');
  // a swatch's context menu
  await runAwait(page, 'window:panel-swatches');
  const sw = page.locator('.swatches-panel .swatch[data-id]').first();
  const hex = await sw.getAttribute('data-color');
  await sw.click({ button: 'right' });
  await page.locator('.popover').last().getByText('Copy Color\'s Hex Code').click();
  await expect.poll(() => page.evaluate(() => window.__pigmentTest.clipboardText)).toBe(hex.slice(1));
  // the Color panel's menu
  await runAwait(page, 'window:panel-color');
  await page.locator('.color-panel [data-act="menu"]').click();
  await page.locator('.popover').last().getByText('Copy Color as HTML').click();
  await expect.poll(() => page.evaluate(() => window.__pigmentTest.clipboardText)).toBe('COLOR="#ff8800"');
  expect(errors).toEqual([]);
});

test('the Eyedropper\'s five Sample choices, with a layer above and an adjustment layer; a drag off the image samples the screen', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 120, height: 80 });
  await runAwait(page, 'view:zoom-fit');
  await page.evaluate(async () => {
    const app = window.pigmentApp;
    const d = app.doc;
    const fill = (layer, color, w = layer.canvas.width) => {
      const ctx = layer.canvas.getContext('2d');
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, w, layer.canvas.height);
      layer.touch();
      d.changed('pixels', { layer });
    };
    fill(d.active, '#808080');
    await app.commands.run('layer:new', undefined, 'api');
    fill(d.active, '#ff0000', 60); // the current layer: red over the left half
    window.__current = d.active.id;
    await app.commands.run('layer:new-adjustment', { kind: 'invert' }, 'api');
    await app.commands.run('layer:new', undefined, 'api');
    fill(d.active, '#00ff00', 30); // a green layer on top, the left quarter
    d.setActive(d.find(window.__current));
  });
  const at = (source, x) => page.evaluate(([s, px]) => {
    const t = window.pigmentApp.tools.get('eyedropper');
    t.setOpt('sample', '1');
    t.setOpt('source', s);
    return t.sampleColor({ x: px, y: 10 })?.slice(0, 3).map(Math.round) ?? null;
  }, [source, x]);
  // x = 10: green on top, the adjustment inverts red below it; x = 45: no green; x = 90: only the grey background
  expect(await at('layer', 10)).toEqual([255, 0, 0]);
  expect(await at('layer', 90)).toEqual(null); // transparent there
  expect(await at('below', 45)).toEqual([255, 0, 0]);
  expect(await at('below', 90)).toEqual([128, 128, 128]);
  expect(await at('merged', 10)).toEqual([0, 255, 0]);
  expect(await at('merged', 45)).toEqual([0, 255, 255]); // red inverted
  expect(await at('merged-no-adj', 45)).toEqual([255, 0, 0]);
  expect(await at('below-no-adj', 45)).toEqual([255, 0, 0]);
  // a drag that leaves the image samples the screen on release (EyeDropper, from sRGB)
  await page.evaluate(() => {
    window.EyeDropper = class {
      open() {
        return Promise.resolve({ sRGBHex: '#4060c0' });
      }
    };
    window.pigmentApp.tools.activate('eyedropper');
  });
  const p = await screenPoint(page, 50, 40);
  const r = await page.locator('.doc-frame:not([hidden]) canvas.view').boundingBox();
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await page.mouse.move(r.x + r.width + 40, p.y, { steps: 6 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => window.pigmentApp.settings.foreground)).toBe('#4060c0');
  expect(errors).toEqual([]);
});

test('Color Libraries: Load Book (.acb), find a colour by name, the picker returns a book colour with its Lab; Add to Swatches keeps the book; opening an .acb adds the book', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  await page.evaluate(async () => {
    const M = await import('/lib/color-picker-model.js');
    window.__pigmentTest.files['mem:/Test Book.acb'] = M.writeAcb({ title: 'Test Book', prefix: 'TB ', postfix: ' C', colorSpace: 'lab', colors: [
      { name: '100', code: 'TB100', color: { values: [50, 60, 40] } },
      { name: '200', code: 'TB200', color: { values: [70, -40, 30] } },
      { name: '300', code: 'TB300', color: { values: [30, 10, -50] } },
    ] });
    window.__pigmentTest.nextOpenFiles = ['mem:/Test Book.acb'];
  });
  await openPicker(page, { initial: '#2050c0' });
  await picker(page).locator('.cp-libraries').click();
  const lib = page.locator('.color-libraries-dialog');
  await expect(lib).toBeVisible();
  await expect(lib.locator('.cl-empty')).toBeVisible();
  await lib.locator('.cl-load').click();
  await expect(lib.locator('.cl-color')).toHaveCount(3);
  await expect(lib.locator('[data-k="book"] option')).toHaveText(['Test Book']);
  // the picker's blue is nearest TB 300 C
  await expect(lib.locator('.cl-color[aria-selected="true"]')).toHaveAttribute('data-name', 'TB 300 C');
  await lib.locator('[data-k="search"]').fill('200');
  await expect(lib.locator('.cl-color')).toHaveCount(1);
  await expect(lib.locator('.cl-color[aria-selected="true"]')).toHaveAttribute('data-name', 'TB 200 C');
  await lib.locator('.dialog-buttons .btn.primary').click();
  await expect(lib).toHaveCount(0);
  await expect(picker(page).locator('.cp-book')).toHaveText('Test Book: TB 200 C');
  const want = await page.evaluate(async () => {
    const { fromLab } = await import('/lib/color/pipeline.js');
    const rgb = fromLab([70.2, -40, 30], null); // L 70 is stored in the book as a byte: 70.2
    return '#' + rgb.map((v) => v.toString(16).padStart(2, '0')).join('');
  });
  await expect(picker(page).locator('[data-f="hex"]')).toHaveValue(want.slice(1));
  // Add to Swatches keeps the book colour's Lab and name
  await picker(page).locator('.cp-add').click();
  await expect(picker(page).locator('.cp-add')).toContainText('Added');
  await picker(page).locator('.dialog-buttons .btn.primary').click();
  const v = await picked(page);
  expect(v).toEqual({ hex: want, rgb: expect.any(Array), book: { book: 'Test Book', name: 'TB 200 C' }, lab: [70.2, -40, 30], space: 'book' });
  const sw = await page.evaluate(() => window.pigmentApp.presets.list('swatches').find((p) => p.name === 'TB 200 C')?.data);
  expect(sw).toEqual({ color: { space: 'lab', values: [70.2, -40, 30] }, type: 'spot', book: { book: 'Test Book', name: 'TB 200 C' } });
  // the book is a `color-books` preset with its colours in a side file; opening an .acb file adds another
  const books = await page.evaluate(async () => {
    const app = window.pigmentApp;
    const M = await import('/lib/color-picker-model.js');
    window.__pigmentTest.files['mem:/Other.acb'] = M.writeAcb({ title: 'Other', colorSpace: 'rgb', colors: [{ name: 'One', code: 'O1', color: { values: [1, 2, 3] } }] });
    const { importPresetFiles } = await import('/lib/preset-formats.js');
    await importPresetFiles(app, { paths: ['mem:/Other.acb'] });
    return app.presets.list('color-books').map((p) => [p.name, p.data.count, /^book-[0-9a-f]{40}\.json$/.test(p.data.blob)]);
  });
  expect(books).toEqual([['Test Book', 3, true], ['Other', 1, true]]);
  expect(errors).toEqual([]);
});

test('the Color panel: Hue Cube, Brightness Cube and Color Wheel views, RGB and Lab sliders, ramps; the foreground follows without history', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  await runAwait(page, 'window:panel-color');
  const hist = await page.evaluate(() => window.pigmentApp.doc.history.index);
  const panel = page.locator('.color-panel');
  const choose = async (label) => {
    await panel.locator('[data-act="menu"]').click();
    await page.locator('.popover').last().getByText(label, { exact: true }).click();
  };
  await expect(panel).toHaveAttribute('data-view', 'hue-cube');
  await expect(panel.locator('.color-widget [data-f="hex"]')).toBeVisible(); // 0.4's widget, fields included
  await choose('Color Wheel');
  await expect(panel).toHaveAttribute('data-view', 'wheel');
  const wheel = await panel.locator('.color-wheel-view canvas').boundingBox();
  // the top of the ring: red hue; the square's top-right corner: full saturation and brightness
  await page.evaluate(() => window.pigmentApp.setColors({ foreground: '#808080' }));
  await page.mouse.click(wheel.x + wheel.width / 2, wheel.y + 12);
  await page.mouse.click(wheel.x + wheel.width / 2 + 40, wheel.y + wheel.height / 2 - 40);
  await expect.poll(() => page.evaluate(() => window.pigmentApp.settings.foreground)).not.toBe('#808080');
  await choose('Brightness Cube');
  await expect(panel.locator('.cpx-field')).toBeVisible();
  await choose('RGB Sliders');
  const red = panel.locator('input[data-slider-num="rgb.r"]');
  await red.fill('10');
  await red.press('Enter');
  await expect.poll(() => page.evaluate(() => window.pigmentApp.settings.foreground.slice(1, 3))).toBe('0a');
  await choose('Lab Sliders');
  await panel.locator('input[data-slider-num="lab.L"]').fill('100');
  await panel.locator('input[data-slider-num="lab.L"]').press('Enter');
  await panel.locator('input[data-slider-num="lab.a"]').fill('0');
  await panel.locator('input[data-slider-num="lab.a"]').press('Enter');
  await panel.locator('input[data-slider-num="lab.b"]').fill('0');
  await panel.locator('input[data-slider-num="lab.b"]').press('Enter');
  await expect.poll(() => page.evaluate(() => window.pigmentApp.settings.foreground)).toBe('#ffffff');
  await choose('Grayscale Ramp');
  const ramp = await panel.locator('.color-ramp').boundingBox();
  await panel.locator('.color-ramp').click({ position: { x: 0.2, y: ramp.height / 2 } });
  await expect.poll(() => page.evaluate(() => window.pigmentApp.settings.foreground)).toBe('#000000');
  await choose('Make Ramp Web Safe');
  await expect(panel.locator('.popover')).toHaveCount(0);
  await panel.locator('.color-ramp').click({ position: { x: ramp.width * 0.42, y: ramp.height / 2 } });
  await expect.poll(async () => (await page.evaluate(() => window.pigmentApp.settings.foreground)).slice(1, 3)).toBe('66');
  expect(await page.evaluate(() => window.pigmentApp.settings.colorUI.panel)).toEqual({ view: 'brightness-cube', sliders: 'lab', ramp: 'gray', webRamp: true });
  expect(await page.evaluate(() => window.pigmentApp.doc.history.index)).toBe(hist);
  await choose('Hue Cube');
  await choose('No Sliders');
  await choose('No Color Ramp');
  expect(errors).toEqual([]);
});

test('modes and preferences: a Grayscale document\'s picker shows the grey it paints; the System picker; the Color Picker section', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  await runAwait(page, 'image:mode', { mode: 'grayscale', silent: true, flatten: true });
  await page.evaluate(() => {
    window.pigmentApp.commands.run('tool:pick-fg', undefined, 'api');
  });
  await expect(picker(page)).toBeVisible();
  await typeField(page, '[data-f="hex"]', 'ff0000');
  const shown = await picker(page).locator('.cp-new').evaluate((e) => getComputedStyle(e).backgroundColor);
  const [r, g, b] = shown.match(/\d+/g).map(Number);
  expect(r).toBe(g);
  expect(g).toBe(b);
  await picker(page).locator('.dialog-buttons .btn.primary').click();
  await expect.poll(() => page.evaluate(() => window.pigmentApp.settings.foreground)).toBe(`#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`);
  // Preferences: the section, and the System picker
  await page.evaluate(() => {
    window.__prefs = window.pigmentApp.preferencesDialog();
  });
  await expect(page.locator('.prefs-dialog .section', { hasText: 'Color Picker' })).toHaveCount(1);
  await page.locator('.prefs-dialog select[data-key="colorUIPicker"]').selectOption('system');
  await page.locator('.prefs-dialog select[data-key="colorUIHud"]').selectOption('hue-wheel');
  await confirmDialog(page);
  await expect.poll(() => page.evaluate(() => window.pigmentApp.settings.colorUI)).toMatchObject({ picker: 'system', hud: 'hue-wheel' });
  await openPicker(page, { initial: '#336699' });
  await expect(page.locator('.system-picker input[type="color"]')).toHaveValue('#336699');
  await page.locator('.system-picker input[type="color"]').evaluate((i) => {
    i.value = '#00ff00';
    i.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.locator('.system-picker .dialog-buttons .btn.primary').click();
  expect((await picked(page)).hex).toBe('#00ff00');
  expect(errors).toEqual([]);
});
