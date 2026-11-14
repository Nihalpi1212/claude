// conventions-shortcuts-fields (ARCHITECTURE.md "0.4 features", package 16): numeric fields (arithmetic, units,
// Shift+arrow, the wheel, scrubby labels, every plain number input), Toggle Last State, Edit > Search, temporary and
// spring-loaded tools, tool switching, movable dialogs over a navigable canvas, Alt = Reset.
import { test, expect } from '@playwright/test';
import { openApp, newDoc, run, runAwait, screenPoint, historyLength } from './helpers.mjs';

const dialogReady = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));

/** Opens a formDialog over `fields`; its result lands in window.__form. */
const openForm = (page, fields, extra = {}) =>
  page.evaluate(([f, x]) => {
    window.__form = import('/lib/form.js').then(({ formDialog }) => formDialog(window.pigmentApp, { title: 'Fields', fields: f, ...x }));
  }, [fields, extra]);

test('numeric fields: arithmetic, percent, typed units, Shift+arrow, the wheel, Escape and invalid entries', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 300, height: 200 });
  await page.evaluate(() => (window.pigmentApp.doc.dpi = 300));
  await openForm(page, [
    { key: 'a', label: 'Amount', type: 'number', value: 100, min: 0, max: 1000 },
    { key: 'w', label: 'Width', type: 'number', value: 10, min: 0, max: 5000, unit: 'px' },
    { key: 'o', label: 'Opacity', type: 'slider', value: 40, min: 0, max: 100, step: 1, unit: '%' },
  ]);
  await dialogReady(page);
  const a = page.locator('.dialog input[data-key="a"]');
  const w = page.locator('.dialog input[data-key="w"]');
  // the field is a number input at rest and while focused
  await a.click();
  await expect(a).toHaveAttribute('type', 'number');
  await page.keyboard.press('End');
  await page.keyboard.type('+50');
  // the operator turned it into a text input that holds the expression
  await expect(a).toHaveAttribute('type', 'text');
  await expect(a).toHaveValue('100+50');
  await page.keyboard.press('Tab');
  await expect(a).toHaveAttribute('type', 'number');
  await expect(a).toHaveValue('150');
  // 2in at 300 ppi in a px field; a percentage of the value the field had
  await w.fill('');
  await w.click();
  await page.keyboard.type('2in');
  await page.keyboard.press('Tab');
  await expect(w).toHaveValue('600');
  await w.click();
  await page.keyboard.press('End');
  await page.keyboard.type('%');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  await page.keyboard.type('50%');
  await page.keyboard.press('Tab');
  await expect(w).toHaveValue('300');
  // an entry that is not valid keeps the old value
  await w.click();
  await page.keyboard.press('End');
  await page.keyboard.type('+*');
  await page.keyboard.press('Tab');
  await expect(w).toHaveValue('300');
  // Escape in a field holding an expression restores it (the dialog then closes as Escape does in 0.3: not here,
  // the field is checked through a plain panel input below)
  // Shift+arrow steps ten, the arrow one; the wheel over the focused field steps too
  await a.click();
  await page.keyboard.press('Shift+ArrowUp');
  await expect(a).toHaveValue('160');
  await page.keyboard.press('ArrowDown');
  await expect(a).toHaveValue('159');
  const box = await a.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -100);
  await expect(a).toHaveValue('160');
  // Enter evaluates the field before OK reads the values
  await page.keyboard.type('*2');
  await page.keyboard.press('Enter');
  const values = await page.evaluate(() => window.__form);
  expect(values).toMatchObject({ a: 320, w: 300, o: 40 });
  expect(errors).toEqual([]);
});

test('plain number inputs get the same: arithmetic, Escape restores, Shift+arrow, and their label scrubs', async ({ page }) => {
  const errors = await openApp(page);
  await page.evaluate(() => {
    const host = document.createElement('div');
    host.id = 'plain-host';
    host.style.cssText = 'position:fixed;left:20px;top:200px;z-index:3000;background:#fff;padding:8px';
    host.innerHTML = '<label id="plain-label" style="display:inline-block;padding:4px 30px 4px 4px">Radius <input id="plain" type="number" value="10" min="0" max="500" step="1"></label>';
    document.body.appendChild(host);
    window.__plain = [];
    const input = host.querySelector('#plain');
    input.addEventListener('input', () => window.__plain.push(['input', input.value]));
    input.addEventListener('change', () => window.__plain.push(['change', input.value]));
  });
  const input = page.locator('#plain');
  await input.click();
  await page.keyboard.press('End');
  await page.keyboard.type('*3');
  // listeners never see the half-typed expression
  expect(await page.evaluate(() => window.__plain)).toEqual([]);
  await page.keyboard.press('Enter');
  await expect(input).toHaveValue('30');
  await expect(input).toHaveAttribute('type', 'number');
  expect(await page.evaluate(() => window.__plain)).toEqual([['input', '30'], ['change', '30']]);
  // Escape gives back what the field had before the expression
  await page.keyboard.type('+7');
  await page.keyboard.press('Escape');
  await expect(input).toHaveValue('30');
  await expect(input).toHaveAttribute('type', 'number');
  await page.keyboard.press('Shift+ArrowDown');
  await expect(input).toHaveValue('20');
  // the wrapping label scrubs: right adds a step per pixel, Shift ten
  const lb = await page.locator('#plain-label').boundingBox();
  await page.mouse.move(lb.x + 8, lb.y + lb.height / 2);
  await page.mouse.down();
  await page.mouse.move(lb.x + 28, lb.y + lb.height / 2, { steps: 5 });
  await page.mouse.up();
  await expect(input).toHaveValue('40');
  expect((await page.evaluate(() => window.__plain)).at(-1)).toEqual(['change', '40']);
  expect(errors).toEqual([]);
});

test('Blur Gallery: 100+50 and Enter set the field to 150, the next Enter applies the gallery', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  await page.evaluate(() => {
    const l = window.pigmentApp.doc.active, ctx = l.canvas.getContext('2d');
    for (let x = 0; x < 400; x += 20) {
      ctx.fillStyle = (x / 20) % 2 ? '#e03030' : '#ffffff';
      ctx.fillRect(x, 0, 20, 300);
    }
    l.touch();
    window.pigmentApp.doc.changed('pixels');
  });
  const h0 = await historyLength(page);
  await run(page, 'filter:field-blur');
  await expect(page.locator('.bg-panel')).toBeVisible();
  const field = page.locator('.bg-panel input[data-key="blur"]');
  await field.click();
  await field.fill('100');
  await page.keyboard.press('End');
  await page.keyboard.type('+50');
  await page.keyboard.press('Enter');
  await expect(field).toHaveValue('150');
  await expect(field).toHaveAttribute('type', 'number');
  expect(await page.evaluate(() => window.pigmentApp.blurGallery.params.pins[0].blur)).toBe(150);
  // the field handed the keys back to the canvas: this Enter applies
  await page.keyboard.press('Enter');
  await expect(page.locator('.bg-panel')).toHaveCount(0);
  await expect.poll(() => historyLength(page)).toBe(h0 + 1);
  expect(errors).toEqual([]);
});

test('Toggle Last State: twice returns to the same state; it is undo-like for the recorder', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  expect(await page.evaluate(() => window.pigmentApp.stubbed.includes('edit:toggle-last-state'))).toBe(false);
  await runAwait(page, 'layer:new');
  await runAwait(page, 'layer:new');
  await expect.poll(() => page.evaluate(() => window.pigmentApp.doc.history.index)).toBeGreaterThan(0);
  const state = () => page.evaluate(() => ({ index: window.pigmentApp.doc.history.index, layers: window.pigmentApp.doc.root.children.length }));
  const s0 = await state();
  await page.keyboard.press('Control+Alt+z');
  const s1 = await state();
  expect(s1.index).toBe(s0.index - 1);
  expect(s1.layers).toBe(s0.layers - 1);
  await page.keyboard.press('Control+Alt+z');
  expect(await state()).toEqual(s0);
  await page.keyboard.press('Control+Alt+z');
  expect(await state()).toEqual(s1);
  await page.keyboard.press('Control+Alt+z');
  expect(await state()).toEqual(s0);
  // after another change it undoes that change first
  await runAwait(page, 'layer:new');
  const s2 = await state();
  // (the same command from another source within 40 ms counts as one: commands.js de-duplication)
  await page.waitForTimeout(60);
  await runAwait(page, 'edit:toggle-last-state');
  expect(await state()).toEqual(s0);
  await runAwait(page, 'edit:toggle-last-state');
  expect(await state()).toEqual(s2);
  expect(await page.evaluate(() => window.pigmentApp.commands.commands.get('edit:toggle-last-state').undoLike)).toBe(true);
  expect(errors).toEqual([]);
});

test('Search: Ctrl+F finds a command by its menu path and runs it; the recorder records that command, not Search', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  // record through the engine: a new set and action
  await page.evaluate(() => {
    const a = window.pigmentApp.actions;
    a.record(a.newAction({ name: 'Searched', set: a.sets[0] }));
  });
  expect(await page.evaluate(() => !!window.pigmentApp.actions.recording)).toBe(true);
  await page.keyboard.press('Control+f');
  const dialog = page.locator('.dialog.command-search');
  await expect(dialog).toBeVisible();
  await page.keyboard.type('invert');
  const row = dialog.locator('.command-search-row').first();
  await expect(row).toHaveAttribute('data-command', 'image:adjust-invert');
  await expect(row.locator('.command-search-path')).toHaveText('Image › Adjustments');
  // tools and panels are there too
  await page.keyboard.press('Control+a');
  await page.keyboard.type('brush tool');
  await expect(dialog.locator('.command-search-row[data-command="tool:brush"]')).toHaveCount(1);
  await page.keyboard.press('Control+a');
  await page.keyboard.type('layers panel');
  await expect(dialog.locator('.command-search-row[data-command="window:panel-layers"]')).toHaveCount(1);
  await page.keyboard.press('Control+a');
  await page.keyboard.type('invert');
  await expect(dialog.locator('.command-search-row').first()).toHaveAttribute('data-command', 'image:adjust-invert');
  const h0 = await historyLength(page);
  await page.keyboard.press('Enter');
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => historyLength(page)).toBe(h0 + 1);
  expect(await page.evaluate(() => window.pigmentApp.doc.history.entries[window.pigmentApp.doc.history.index].label)).toMatch(/Invert/);
  await expect.poll(() => page.evaluate(() => window.pigmentApp.actions.recording.action.steps.map((s) => s.command))).toEqual(['image:adjust-invert']);
  await page.evaluate(() => window.pigmentApp.actions.stopRecording());
  // a command that is not available closes the palette and says so
  await page.keyboard.press('Control+f');
  await page.keyboard.type('menus');
  await expect(dialog.locator('.command-search-row').first()).toHaveAttribute('data-command', 'edit:menus');
  await expect(dialog.locator('.command-search-row').first()).toHaveClass(/disabled/);
  await page.keyboard.press('Enter');
  await expect(page.locator('.toast', { hasText: 'is not available now' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('temporary tools: Ctrl springs to Move, Alt to the Eyedropper, Ctrl+Space zooms in; a held tool key springs back', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { background: 'white' });
  await page.evaluate(() => {
    const l = window.pigmentApp.doc.active, ctx = l.canvas.getContext('2d');
    ctx.fillStyle = '#ff0000';
    ctx.fillRect(0, 0, 200, 300);
    l.touch();
    window.pigmentApp.doc.changed('pixels');
    window.pigmentApp.tools.activate('brush');
  });
  const temp = () => page.evaluate(() => {
    const v = window.pigmentApp.view;
    return v.tempTool ? [v.tempTool.id, v.tempToolVia] : null;
  });
  await page.keyboard.down('Control');
  expect(await temp()).toEqual(['move', 'ctrl']);
  await page.keyboard.up('Control');
  expect(await temp()).toBeNull();
  // Alt: the Eyedropper sets the foreground colour (not the background, as an Alt-click with it would)
  await page.evaluate(() => window.pigmentApp.setColors({ foreground: '#000000', background: '#ffffff' }));
  await page.keyboard.down('Alt');
  expect(await temp()).toEqual(['eyedropper', 'alt']);
  const p = await screenPoint(page, 50, 50);
  await page.mouse.click(p.x, p.y);
  await page.keyboard.up('Alt');
  expect(await temp()).toBeNull();
  expect(await page.evaluate(() => [window.pigmentApp.settings.foreground, window.pigmentApp.settings.background])).toEqual(['#ff0000', '#ffffff']);
  expect(await page.evaluate(() => window.pigmentApp.tools.active.id)).toBe('brush');
  // a shortcut typed with Ctrl drops the temporary tool at once
  await page.keyboard.down('Control');
  await page.keyboard.press('a');
  expect(await temp()).toBeNull();
  await page.keyboard.up('Control');
  await runAwait(page, 'select:none');
  // a tool that uses Ctrl itself (the type tools) keeps it
  await page.evaluate(() => window.pigmentApp.tools.activate('type-horizontal'));
  await page.keyboard.down('Control');
  expect(await temp()).toBeNull();
  await page.keyboard.up('Control');
  await page.evaluate(() => window.pigmentApp.tools.activate('brush'));
  // Ctrl+Space: a click zooms in at the pointer
  const z0 = await page.evaluate(() => window.pigmentApp.view.zoom);
  await page.keyboard.down('Control');
  await page.keyboard.down(' ');
  expect(await temp()).toEqual(['zoom', 'space']);
  await page.mouse.click(p.x, p.y);
  await page.keyboard.up(' ');
  await page.keyboard.up('Control');
  expect(await temp()).toBeNull();
  const z1 = await page.evaluate(() => window.pigmentApp.view.zoom);
  expect(z1).toBeGreaterThan(z0);
  // Alt+Space zooms out
  await page.keyboard.down('Alt');
  await page.keyboard.down(' ');
  expect(await temp()).toEqual(['zoom', 'space']);
  await page.mouse.click(p.x, p.y);
  await page.keyboard.up(' ');
  await page.keyboard.up('Alt');
  expect(await page.evaluate(() => window.pigmentApp.view.zoom)).toBeLessThan(z1);
  expect(await page.evaluate(() => window.pigmentApp.tools.active.id)).toBe('brush');
  // spring-loaded: holding V switches to Move only while held; a short press switches for good
  await page.keyboard.down('v');
  expect(await page.evaluate(() => window.pigmentApp.tools.active.id)).toBe('move');
  await page.waitForTimeout(550);
  await page.keyboard.up('v');
  expect(await page.evaluate(() => window.pigmentApp.tools.active.id)).toBe('brush');
  await page.keyboard.press('v');
  expect(await page.evaluate(() => window.pigmentApp.tools.active.id)).toBe('move');
  // with spring-loaded tools off, a hold switches for good too
  await page.evaluate(() => window.pigmentApp.saveSettingsSoon({ conventions: { ...window.pigmentApp.settings.conventions, springLoaded: false } }));
  await page.keyboard.press('b');
  await page.keyboard.down('v');
  await page.waitForTimeout(550);
  await page.keyboard.up('v');
  expect(await page.evaluate(() => window.pigmentApp.tools.active.id)).toBe('move');
  await page.keyboard.down('Control');
  expect(await temp()).toBeNull();
  await page.keyboard.up('Control');
  expect(errors).toEqual([]);
});

test('tool switching: Shift+letter steps through a slot; with "Use Shift Key for Tool Switch" off the letter does', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  const active = () => page.evaluate(() => window.pigmentApp.tools.active.id);
  const slot = await page.evaluate(() => window.pigmentApp.tools.slots.find((s) => s.id === 'marquee').tools);
  await page.keyboard.press('m');
  const first = await active();
  await page.keyboard.press('m');
  expect(await active()).toBe(first);
  await page.keyboard.press('Shift+M');
  const second = await active();
  expect(second).toBe(slot[(slot.indexOf(first) + 1) % slot.length]);
  await page.evaluate(() => window.pigmentApp.saveSettingsSoon({ conventions: { ...window.pigmentApp.settings.conventions, toolSwitchWithShift: false } }));
  await page.keyboard.press('m');
  expect(await active()).toBe(slot[(slot.indexOf(second) + 1) % slot.length]);
  // Alt-click on the toolbox button steps too
  const before = await active();
  await page.locator('#toolbox .tool-button[data-slot="marquee"]').click({ modifiers: ['Alt'] });
  expect(await active()).toBe(slot[(slot.indexOf(before) + 1) % slot.length]);
  // the preference is in Preferences > Tools and shortcuts
  await run(page, 'edit:preferences');
  await expect(page.locator('.dialog .section', { hasText: 'Tools and shortcuts' })).toHaveCount(1);
  await expect(page.locator('.dialog input[data-key="conventionsShiftSwitch"]')).not.toBeChecked();
  await page.locator('.dialog input[data-key="conventionsShiftSwitch"]').check();
  await page.locator('.dialog .dialog-buttons .btn.primary').click();
  await expect.poll(() => page.evaluate(() => window.pigmentApp.settings.conventions.toolSwitchWithShift)).toBe(true);
  expect(errors).toEqual([]);
});

test('dialogs: move by the header and reopen there; the canvas under them zooms and pans; a click beside keeps them', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  await openForm(page, [{ key: 'a', label: 'Amount', type: 'number', value: 5 }], { title: 'Mover' });
  await dialogReady(page);
  const dialog = page.locator('.dialog');
  const header = dialog.locator('.dialog-header');
  const hb = await header.boundingBox();
  await page.mouse.move(hb.x + 40, hb.y + 10);
  await page.mouse.down();
  await page.mouse.move(60, 70, { steps: 6 });
  await page.mouse.up();
  // the header's grab point stays under the pointer
  const hb2 = await header.boundingBox();
  expect([Math.round(hb2.x), Math.round(hb2.y)]).toEqual([20, 60]);
  const db = await dialog.boundingBox();
  const saved = await page.evaluate(() => window.pigmentApp.settings.conventions.dialogPositions.Mover);
  expect(saved).toEqual({ x: Math.round(db.x), y: Math.round(db.y) });
  // the backdrop does not dim the canvas, and a click on the canvas beside the dialog does not cancel it
  await expect(page.locator('.dialog-backdrop')).toHaveClass(/over-canvas/);
  const c = await screenPoint(page, 380, 280);
  await page.mouse.click(c.x, c.y);
  await expect(dialog).toHaveCount(1);
  // zoom keys and the native menu's view commands work under the dialog
  const z0 = await page.evaluate(() => window.pigmentApp.view.zoom);
  await dialog.locator('input[data-key="a"]').focus();
  await page.keyboard.press('Control+=');
  const z1 = await page.evaluate(() => window.pigmentApp.view.zoom);
  expect(z1).toBeGreaterThan(z0);
  expect(await page.evaluate(() => window.pigmentApp.dialogs.passesMenu('view:zoom-out'))).toBe(true);
  expect(await page.evaluate(() => window.pigmentApp.dialogs.passesMenu('layer:new'))).toBe(false);
  await page.evaluate(() => window.pigmentApp.commands.run('view:zoom-out', undefined, 'menu-key'));
  await expect.poll(() => page.evaluate(() => window.pigmentApp.view.zoom)).toBeLessThan(z1);
  // Space-drag on the canvas beside the dialog pans it
  const pan0 = await page.evaluate(() => [window.pigmentApp.view.panX, window.pigmentApp.view.panY]);
  await page.keyboard.down(' ');
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await page.mouse.move(c.x - 40, c.y - 30, { steps: 4 });
  await page.mouse.up();
  await page.keyboard.up(' ');
  const pan1 = await page.evaluate(() => [window.pigmentApp.view.panX, window.pigmentApp.view.panY]);
  expect(Math.round(pan1[0] - pan0[0])).toBe(-40);
  expect(Math.round(pan1[1] - pan0[1])).toBe(-30);
  await expect(dialog).toHaveCount(1);
  // the wheel over the canvas beside the dialog scrolls the view
  await page.mouse.move(c.x, c.y);
  await page.mouse.wheel(0, 50);
  await expect.poll(() => page.evaluate(() => window.pigmentApp.view.panY)).toBeLessThan(pan1[1]);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  // the dialog opens where it was left; a double-click on the header centres it again
  await openForm(page, [{ key: 'a', label: 'Amount', type: 'number', value: 5 }], { title: 'Mover' });
  await dialogReady(page);
  const db2 = await dialog.boundingBox();
  expect([Math.round(db2.x), Math.round(db2.y)]).toEqual([saved.x, saved.y]);
  await header.dblclick();
  await expect.poll(() => page.evaluate(() => window.pigmentApp.settings.conventions.dialogPositions.Mover ?? null)).toBeNull();
  await page.keyboard.press('Escape');
  expect(errors).toEqual([]);
});

test('Alt turns Cancel into Reset: the fields go back to what the dialog opened with, the dialog stays', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  await openForm(page, [
    { key: 'a', label: 'Amount', type: 'number', value: 5 },
    { key: 'm', label: 'Mode', type: 'select', options: ['one', 'two'], value: 'one' },
  ], { values: { a: 12, m: 'one' } });
  await dialogReady(page);
  const cancel = page.locator('.dialog .dialog-buttons button[data-value="null"]');
  await page.locator('.dialog input[data-key="a"]').fill('40');
  await page.locator('.dialog input[data-key="a"]').dispatchEvent('change');
  await page.locator('.dialog select[data-key="m"]').selectOption('two');
  await expect(cancel).toHaveText('Cancel');
  await page.keyboard.down('Alt');
  await expect(cancel).toHaveText('Reset');
  await cancel.click({ modifiers: ['Alt'] });
  await page.keyboard.up('Alt');
  await expect(cancel).toHaveText('Cancel');
  await expect(page.locator('.dialog input[data-key="a"]')).toHaveValue('12');
  await expect(page.locator('.dialog select[data-key="m"]')).toHaveValue('one');
  await page.locator('.dialog .dialog-buttons .btn.primary').click();
  expect(await page.evaluate(() => window.__form)).toMatchObject({ a: 12, m: 'one' });
  // an adjustment dialog resets to the parameters it opened with
  await run(page, 'image:adjust-brightness-contrast');
  const bright = page.locator('.dialog input[type="number"][data-key="brightness"]');
  await expect(bright).toBeVisible();
  const start = await bright.inputValue();
  await bright.fill('60');
  await bright.dispatchEvent('change');
  await page.locator('.dialog .dialog-buttons button[data-value="null"]').click({ modifiers: ['Alt'] });
  await expect(bright).toHaveValue(start);
  await page.keyboard.press('Escape');
  await expect(page.locator('.dialog')).toHaveCount(0);
  expect(errors).toEqual([]);
});
