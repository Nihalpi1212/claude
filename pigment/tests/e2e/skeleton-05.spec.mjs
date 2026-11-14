// Pigment 0.5 skeleton smoke spec (port 8850, ARCHITECTURE.md "0.5 features", Part 2). Each step of the skeleton adds
// its tests here: "stubs" (step 2), "keys" (step 3), "brush" (4), "psd" (5), "colour" (6), "camera raw" (7), "colour ui"
// (8), "type" (9), "presets" (10), "toolbox" (11).
//
// Rule 11: this spec stays green before and after each 0.5 package lands. An assertion about a stub's own behaviour
// runs only while the stub is in place, read from the capability flags of S15 (landed() below); the same test checks
// the landed behaviour otherwise.
import { test, expect } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openApp, newDoc, runAwait } from './helpers.mjs';
import { PSD_GOLDEN_DOCS, pagePsdGolden } from './goldens.mjs';

const RENDERER = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'renderer');

// S15: how each package's landing is read in the page. A package with a `stub` has landed when that S13.3 id is no
// longer a stub; the others are read from their module's flag (a module that does not exist yet answers false).
const STUB_OWNERS = {
  'brush-settings-panel': 'window:panel-brush-settings',
  'presets-panels': 'window:panel-styles',
  'preset-files-manager': 'edit:preset-manager',
  'type-menu-commands': 'type:warp-text',
  'shortcuts-editor': 'edit:menus',
};

const FLAG_MODULES = ['/lib/brush.js', '/lib/tools/paint-gesture.js', '/lib/color/pipeline.js', '/lib/psd/registry.js', '/lib/develop/registry.js', '/lib/type/api.js', '/lib/tools/move-handles.js', '/lib/brush/abr.js', '/lib/preset-files/aco-ase.js'];

/** { [package]: true when it has landed } (S15). */
async function landed(page) {
  // a module the skeleton has not landed yet is not imported (its 404 would be a console error)
  const present = FLAG_MODULES.filter((m) => existsSync(join(RENDERER, m)));
  return page.evaluate(async ([stubOwners, present]) => {
    const app = window.pigmentApp;
    const mod = async (path) => {
      if (!present.includes(path)) return {};
      try {
        return await import(path);
      } catch {
        return {};
      }
    };
    const ask = (fn) => {
      try {
        return fn() === true;
      } catch {
        return false;
      }
    };
    const brush = await mod('/lib/brush.js');
    const gesture = await mod('/lib/tools/paint-gesture.js');
    const pipeline = await mod('/lib/color/pipeline.js');
    const psd = await mod('/lib/psd/registry.js');
    const develop = await mod('/lib/develop/registry.js');
    const typeApi = await mod('/lib/type/api.js');
    const move = await mod('/lib/tools/move-handles.js');
    const abr = await mod('/lib/brush/abr.js');
    const acoAse = await mod('/lib/preset-files/aco-ase.js');
    const out = Object.fromEntries(Object.entries(stubOwners).map(([pkg, id]) => [pkg, !app.stubbed.includes(id)]));
    Object.assign(out, {
      'brush-engine-core': ask(() => !!brush.ENGINE && brush.ENGINE.id !== 'classic-0.4'),
      'brush-painting-behaviours': ask(() => gesture.PaintGesture?.real),
      'icc-engine': ask(() => pipeline.colorEngine?.().available),
      'psd-layers': ask(() => psd.psdFeatures?.().effects),
      'psd-text': ask(() => psd.psdFeatures?.().textRuns),
      'camera-raw-workspace': ask(() => develop.developFeatures?.().workspace),
      'camera-raw-panels': ask(() => develop.developFeatures?.().panels),
      'color-picker-swatches': ask(() => app.colorPicker?.real),
      'type-fonts': ask(() => typeApi.fontCatalog?.().real),
      'move-tool-depth': ask(() => move.MOVE_FEATURES?.handles),
      // second flags of two packages (S15)
      abrReal: ask(() => abr.ABR_REAL),
      acoAseReal: ask(() => acoAse.ACO_ASE_REAL),
    });
    return out;
  }, [STUB_OWNERS, present]);
}

// S13.3: every new command id of 0.5 with its owner ('skeleton' ids are real from the step that lands them)
const DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
const PAINT_BLEND = ['normal', 'dissolve', 'darken', 'multiply', 'color-burn', 'linear-burn', 'lighten', 'screen', 'color-dodge', 'linear-dodge', 'overlay', 'soft-light', 'hard-light', 'vivid-light', 'linear-light', 'pin-light', 'hard-mix', 'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity', 'behind', 'clear'];
const S13_3 = {
  'window:panel-brush-settings': 'brush-settings-panel',
  'window:panel-styles': 'presets-panels', 'window:panel-shapes': 'presets-panels', 'window:panel-tool-presets': 'presets-panels',
  'edit:define-brush': 'brush-engine-core',
  'edit:define-custom-shape': 'presets-panels',
  'edit:preset-manager': 'preset-files-manager', 'edit:export-import-presets': 'preset-files-manager', 'edit:migrate-presets': 'preset-files-manager',
  'edit:assign-profile': 'icc-engine',
  'edit:color-settings': 'later', 'edit:convert-profile': 'later',
  'edit:camera-raw-preferences': 'camera-raw-workspace',
  'edit:menus': 'shortcuts-editor', 'edit:show-all-menu-items': 'shortcuts-editor',
  'help:shortcuts': 'working',
  'type:add-fonts': 'type-fonts', 'type:font-preview-size': 'type-fonts', 'type:manage-missing-fonts': 'type-fonts', 'type:replace-missing-fonts': 'type-fonts',
  'type:anti-alias': 'type-menu-commands', 'type:warp-text': 'type-menu-commands', 'type:create-work-path': 'type-menu-commands',
  'type:convert-to-shape': 'type-menu-commands', 'type:convert-text-kind': 'type-menu-commands', 'type:update-all': 'type-menu-commands',
  'type:paste-lorem-ipsum': 'type-menu-commands', 'type:toggle-orientation': 'type-menu-commands',
  'tool:type-mask-horizontal': 'type-menu-commands', 'tool:type-mask-vertical': 'type-menu-commands',
  'tool:brush-preset': 'skeleton',
  'tool:airbrush-toggle': 'brush-engine-core',
  'tool:brush-prev': 'brush-painting-behaviours', 'tool:brush-next': 'brush-painting-behaviours', 'tool:brush-first': 'brush-painting-behaviours', 'tool:brush-last': 'brush-painting-behaviours',
  ...Object.fromEntries(DIGITS.map((d) => [`tool:opacity-digit-${d}`, 'brush-painting-behaviours'])),
  ...Object.fromEntries(DIGITS.map((d) => [`tool:flow-digit-${d}`, 'brush-painting-behaviours'])),
  ...Object.fromEntries(PAINT_BLEND.map((m) => [`tool:blend-mode-${m}`, 'brush-painting-behaviours'])),
  'tool:preset': 'presets-panels', 'tool:reset': 'presets-panels', 'tool:reset-all': 'presets-panels',
  'layer:style-preset': 'presets-panels',
};
// skeleton ids a later step of the skeleton lands (Part 2): until that step they may be missing (none since step 4,
// which registered tool:brush-preset)
const SKELETON_LATER = new Set([]);

// ---- step 2: stubs ----------------------------------------------------------------------------------------------

test('stubs: every S13.3 id is a disabled stub in app.stubbed or a real registration; help:shortcuts works', async ({ page }) => {
  const errors = await openApp(page);
  const done = await landed(page);
  const info = await page.evaluate((ids) => {
    const app = window.pigmentApp;
    return Object.fromEntries(ids.map((id) => [id, { has: app.commands.has(id), stubbed: app.stubbed.includes(id), stub: !!app.commands.commands.get(id)?.stub, enabled: app.commands.has(id) && app.commands.isEnabled(id) }]));
  }, Object.keys(S13_3));
  for (const [id, owner] of Object.entries(S13_3)) {
    const c = info[id];
    if (!c.has && owner === 'skeleton' && SKELETON_LATER.has(id)) continue;
    expect(c.has, id).toBe(true);
    // rule 4: a stub is listed in app.stubbed and disabled; a real registration is neither
    expect(c.stubbed, id).toBe(c.stub);
    if (c.stubbed) expect(c.enabled, id).toBe(false);
    if (owner === 'working' || owner === 'skeleton') expect(c.stubbed, id).toBe(false);
    else if (owner === 'later') expect(c.stubbed, `${id} is a stub until 0.6`).toBe(true);
    // the package's own ids: stubs until it lands (rule 11: only the landed package's ids may be real)
    else if (!done[owner]) expect(c.stubbed, `${id} (${owner} has not landed)`).toBe(true);
  }
  // the record flag the stub declares for its owner (E31)
  expect(await page.evaluate(() => window.pigmentApp.commands.commands.get('edit:show-all-menu-items')?.record)).toBe(false);
  // stubs-later.js: edit:menus moved to shortcuts-editor's stub; 0.6's colour settings commands are stubs
  const later = await page.evaluate(async () => {
    const app = window.pigmentApp;
    const ids = [];
    const fake = { commands: { has: () => false, register: (id) => ids.push(id), commands: new Map() }, stubbed: [] };
    (await import('/lib/stubs-later.js')).install(fake);
    return { ids, stubbed: app.stubbed.filter((id) => id === 'edit:color-settings' || id === 'edit:convert-profile') };
  });
  expect(later.ids).toEqual(['edit:color-settings', 'edit:convert-profile']);
  expect(later.stubbed).toEqual(['edit:color-settings', 'edit:convert-profile']);
  // help:shortcuts (moved from app.js into the shortcuts-editor stub) opens 0.4's list, or the package's dialog
  await page.evaluate(() => {
    window.pigmentApp.commands.run('help:shortcuts', undefined, 'api'); // resolves when the dialog closes
  });
  const dialog = page.locator('.dialog', { hasText: 'Keyboard Shortcuts' });
  await expect(dialog).toBeVisible();
  if (!done['shortcuts-editor']) {
    await expect(dialog.locator('table.kbd-table')).toBeVisible();
    await expect(dialog.locator('td', { hasText: 'Keyboard shortcuts' }).first()).toBeVisible();
  }
  expect(errors).toEqual([]);
});

// ---- step 3: keys and menus (S9, S13) -----------------------------------------------------------------------------

/** Adds a point text layer and opens a type session on it (the hidden textarea has focus). */
async function typeSession(page, text = 'Hello') {
  await newDoc(page);
  const id = await page.evaluate(async (t) => {
    const app = window.pigmentApp;
    const { TextLayer } = await import('/lib/document.js');
    const { structural } = await import('/lib/layer-ops.js');
    const M = await import('/lib/type/model.js');
    const layer = new TextLayer({ content: M.fromPlain(t, { size: 40 }), x: 30, y: 60 });
    layer.name = t;
    structural(app, 'Add', () => {
      app.doc.add(layer);
      app.doc.setActive(layer);
    });
    return layer.id;
  }, text);
  await runAwait(page, 'layer:edit-text', id);
  await expect.poll(() => page.evaluate(() => !!window.pigmentApp.tools.active?.session)).toBe(true);
}
const runsOf = (page) => page.evaluate(() => window.pigmentApp.tools.active.session.layer.content.runs.map((r) => [r.len, !!r.style.fauxBold, !!r.style.fauxItalic]));

test('keys: a rebound type key and a rebound menu key take effect inside a type session', async ({ page }) => {
  const errors = await openApp(page);
  await typeSession(page, 'Hello');
  // a type key moved to another combination: the editor's table follows keymap:changed
  const conflicts = await page.evaluate(() => window.pigmentApp.keymap.set('type:toggle-faux-bold', ['CmdOrCtrl+Alt+Shift+9'], { scope: 'type' }));
  expect(conflicts).toEqual([]);
  await page.evaluate(() => window.pigmentApp.tools.active.session.editor.select(0, 5));
  await page.keyboard.press('Control+Alt+Shift+Digit9');
  await expect.poll(() => runsOf(page)).toEqual([[5, true, false]]);
  // the old combination no longer toggles it
  await page.keyboard.press('Control+Shift+KeyB');
  expect(await runsOf(page)).toEqual([[5, true, false]]);
  // a menu key moved: Select All (answered by the editor) on a new combination selects the whole text
  await page.evaluate(() => window.pigmentApp.keymap.set('select:all', ['CmdOrCtrl+Alt+Shift+8']));
  await page.evaluate(() => window.pigmentApp.tools.active.session.editor.select(2, 2));
  await page.keyboard.press('Control+Alt+Shift+Digit8');
  await page.keyboard.press('Control+Shift+KeyI'); // faux italic, a type key, on the selection
  await expect.poll(() => runsOf(page)).toEqual([[5, true, true]]);
  expect(errors).toEqual([]);
});

test('keys: F5 inside an open dialog does not reload the page; bound function keys never reach the browser', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  await page.evaluate(() => {
    window.__stillHere = true;
    window.__fkeys = [];
    document.addEventListener('keydown', (e) => /^F\d+$/.test(e.key) && window.__fkeys.push([e.key, e.defaultPrevented]));
    window.pigmentApp.dialogs.open({ title: 'Probe', content: document.createElement('div'), buttons: [{ label: 'Close', value: true, primary: true }] });
  });
  await expect(page.locator('.dialog', { hasText: 'Probe' })).toBeVisible();
  await page.keyboard.press('F5');
  await page.keyboard.press('F1');
  await page.keyboard.press('F7');
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.__stillHere === true)).toBe(true);
  expect(await page.evaluate(() => window.__fkeys)).toEqual([['F5', true], ['F1', true], ['F7', true]]);
  // the dialog stays open: the panel commands do not run inside a dialog
  await expect(page.locator('.dialog', { hasText: 'Probe' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('keys: F12 in a focused text input or a type session does not revert, also as a native accelerator', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 60, height: 40 });
  // a saved document with unsaved changes: file:revert is enabled
  await page.evaluate(() => (window.__pigmentTest.nextSavePath = 'mem:/revert.pigment'));
  await runAwait(page, 'file:save-as');
  await expect.poll(() => page.evaluate(() => window.pigmentApp.doc?.path)).toBe('mem:/revert.pigment');
  await runAwait(page, 'layer:new-no-dialog');
  expect(await page.evaluate(() => window.pigmentApp.commands.isEnabled('file:revert'))).toBe(true);
  const reverts = await page.evaluate(() => {
    window.__revert = [];
    window.pigmentApp.commands.observe({ before: (id, arg, source) => (id === 'file:revert' ? window.__revert.push(source) : undefined) });
    return true;
  });
  expect(reverts).toBe(true);
  const revertDialog = page.locator('.dialog', { hasText: 'Discard all changes' });
  // a focused text field: the status bar's zoom field
  await page.locator('.status-zoom input').focus();
  await page.keyboard.press('F12');
  // the native menu's accelerator arrives as source 'menu-key' through the bridge (app.js): refused while typing
  await page.evaluate(() => window.__pigmentTest.bridge.__emit('command', 'file:revert', undefined, true));
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => window.__revert)).toEqual([]);
  await expect(revertDialog).toHaveCount(0);
  await page.locator('.status-zoom input').blur();
  // a type session: neither the page's F12 nor the menu's runs Revert
  await page.evaluate(async () => {
    const app = window.pigmentApp;
    const { TextLayer } = await import('/lib/document.js');
    const { structural } = await import('/lib/layer-ops.js');
    const M = await import('/lib/type/model.js');
    const layer = new TextLayer({ content: M.fromPlain('Hi', { size: 20 }), x: 5, y: 25 });
    structural(app, 'Add', () => {
      app.doc.add(layer);
      app.doc.setActive(layer);
    });
    await app.commands.run('layer:edit-text', layer.id, 'api');
  });
  await expect.poll(() => page.evaluate(() => !!window.pigmentApp.tools.active?.session)).toBe(true);
  await page.keyboard.press('F12');
  await page.evaluate(() => window.__pigmentTest.bridge.__emit('command', 'file:revert', undefined, true));
  await page.waitForTimeout(200);
  await expect(revertDialog).toHaveCount(0);
  expect(await page.evaluate(() => !!window.pigmentApp.tools.active?.session)).toBe(true);
  // outside a text field F12 is Revert (it asks first)
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => !!window.pigmentApp.tools.active?.session)).toBe(false);
  await page.mouse.click(5, 5);
  await page.evaluate(() => document.activeElement?.blur?.());
  await page.keyboard.press('F12');
  await expect(revertDialog).toBeVisible();
  await revertDialog.locator('.dialog-buttons .btn:not(.primary)').first().click();
  expect(errors).toEqual([]);
});

// ---- step 4: the brush (S1-S3) ----------------------------------------------------------------------------------

/** Replaces the Brush's gesture with one that claims `claim(p)` presses and logs what reaches it (S3.1). */
async function fakeGesture(page, claim) {
  await page.evaluate((claimSrc) => {
    const app = window.pigmentApp;
    const brush = app.tools.get('brush');
    const claims = new Function('p', `return (${claimSrc})(p)`);
    window.__gestureLog = [];
    const log = (what, p, extra = {}) => window.__gestureLog.push({ what, button: p?.button, buttons: p?.buttons, alt: !!p?.alt, ctrl: !!p?.ctrl, eraser: !!p?.eraser, pointerType: p?.pointerType, ...extra });
    window.__realGesture ??= brush.gesture;
    brush.gesture = {
      claims: (p) => claims(p),
      down: (p) => log('down', p),
      move: (p, dragging) => log('move', p, { dragging }),
      up: (p) => log('up', p),
      contextDown: (p) => (log('context', p), true),
      cancel: () => false,
    };
  }, claim.toString());
}

test('brush: claimed presses reach the Brush past the temporary tools; a pen eraser press is a primary press', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 300, height: 200, background: 'white' });
  await page.evaluate(() => {
    const app = window.pigmentApp;
    app.tools.activate('brush');
    app.setColors({ foreground: '#123456' });
  });
  const box = await page.locator('.doc-frame:not([hidden]) canvas.view').boundingBox();
  const at = (x, y) => [box.x + box.width / 2 + x, box.y + box.height / 2 + y];

  // Alt held (the temporary Eyedropper) then a right-drag: the gesture claims it, the whole press reaches the Brush
  await fakeGesture(page, (p) => p.alt && p.button === 2);
  await page.mouse.move(...at(0, 0));
  await page.keyboard.down('Alt');
  await expect.poll(() => page.evaluate(() => window.pigmentApp.view.tempTool?.id ?? null)).toBe('eyedropper');
  await page.evaluate(() => (window.__gestureLog.length = 0)); // the hover before the press went to the Brush too
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(...at(30, 10), { steps: 3 });
  await page.mouse.up({ button: 'right' });
  await page.keyboard.up('Alt');
  const alt = await page.evaluate(() => ({ log: window.__gestureLog, fg: window.pigmentApp.settings.foreground, temp: window.pigmentApp.view.tempTool?.id ?? null }));
  expect(alt.log[0]).toMatchObject({ what: 'context', button: 2, alt: true });
  expect(alt.log.filter((e) => e.what === 'move').length).toBeGreaterThan(0);
  expect(alt.log.filter((e) => e.what === 'move').every((e) => e.dragging === true && (e.buttons & 2) === 2)).toBe(true);
  expect(alt.log[alt.log.length - 1]).toMatchObject({ what: 'up', button: 2 });
  // the Eyedropper never sampled
  expect(alt.fg).toBe('#123456');
  expect(alt.temp).toBe(null);

  // Ctrl held (the temporary Move tool) then a Ctrl+Alt-drag (macOS's brush-resize HUD): claimed, the layer stays put
  await page.evaluate(async () => {
    const app = window.pigmentApp;
    const { RasterLayer, createCanvas } = await import('/lib/document.js');
    const { structural } = await import('/lib/layer-ops.js');
    const c = createCanvas(40, 40);
    c.getContext('2d').fillRect(0, 0, 40, 40);
    const layer = new RasterLayer({ name: 'Box', canvas: c, x: 100, y: 60 });
    structural(app, 'Add', () => {
      app.doc.add(layer);
      app.doc.setActive(layer);
    });
  });
  await fakeGesture(page, (p) => p.ctrl && p.alt && p.button === 0);
  await page.mouse.move(...at(0, 0));
  await page.keyboard.down('Control');
  await expect.poll(() => page.evaluate(() => window.pigmentApp.view.tempTool?.id ?? null)).toBe('move');
  await page.keyboard.down('Alt');
  await page.evaluate(() => (window.__gestureLog.length = 0));
  await page.mouse.down();
  await page.mouse.move(...at(40, 20), { steps: 3 });
  await page.mouse.up();
  await page.keyboard.up('Alt');
  await page.keyboard.up('Control');
  const ctrl = await page.evaluate(() => ({ log: window.__gestureLog, x: window.pigmentApp.doc.active.x, y: window.pigmentApp.doc.active.y, entries: window.pigmentApp.doc.history.entries.map((e) => e.label) }));
  expect(ctrl.log[0]).toMatchObject({ what: 'down', ctrl: true, alt: true });
  expect(ctrl.log[ctrl.log.length - 1].what).toBe('up');
  expect([ctrl.x, ctrl.y]).toEqual([100, 60]);
  expect(ctrl.entries.filter((l) => /move/i.test(l))).toEqual([]);

  // a pen's eraser end: pointerdown with button 5 / buttons 32 reaches the active tool's down with eraser: true
  await fakeGesture(page, () => false);
  const pen = await page.evaluate(([x, y]) => {
    const canvas = document.querySelector('.doc-frame:not([hidden]) canvas.view');
    const o = { bubbles: true, cancelable: true, composed: true, pointerId: 1, pointerType: 'pen', isPrimary: true, clientX: x, clientY: y, pressure: 0.6 };
    canvas.dispatchEvent(new PointerEvent('pointerdown', { ...o, button: 5, buttons: 32 }));
    canvas.dispatchEvent(new PointerEvent('pointermove', { ...o, clientX: x + 10, button: -1, buttons: 32 }));
    canvas.dispatchEvent(new PointerEvent('pointerup', { ...o, clientX: x + 10, button: 5, buttons: 0 }));
    return window.__gestureLog;
  }, at(-20, 0));
  expect(pen[0]).toMatchObject({ what: 'down', eraser: true, pointerType: 'pen' });
  expect(pen.some((e) => e.what === 'move' && e.dragging === true && e.eraser)).toBe(true);
  expect(pen[pen.length - 1].what).toBe('up');
  await page.evaluate(() => {
    window.pigmentApp.tools.get('brush').gesture = window.__realGesture;
  });

  // rule 11: the stub gesture claims nothing, so Alt then a right-drag stays with the Eyedropper (and does nothing)
  const done = await landed(page);
  if (!done['brush-painting-behaviours']) {
    const stub = await page.evaluate(async () => {
      const { PaintGesture } = await import('/lib/tools/paint-gesture.js');
      const g = new PaintGesture(window.pigmentApp.tools.get('brush'));
      return { real: PaintGesture.real, claims: g.claims({ alt: true, button: 2 }), context: g.contextDown({ button: 2 }) };
    });
    expect(stub).toEqual({ real: false, claims: false, context: false });
  }
  expect(errors).toEqual([]);
});

test('brush: a modifier\'s reach grows a lazily grown layer around its dabs; renderStrokePreview shows modifiers', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 800, height: 400, background: 'transparent' });
  const r = await page.evaluate(async () => {
    const app = window.pigmentApp;
    const { registerDabModifier, renderStrokePreview } = await import('/lib/brush.js');
    const { normalizeBrush } = await import('/lib/brush/preset.js');
    app.tools.activate('brush');
    app.tools.setOpt('brush', 'size', 20);
    app.tools.setOpt('brush', 'hardness', 1);
    const layer = app.doc.active;
    const before = { x: layer.x, y: layer.y, w: layer.canvas.width, h: layer.canvas.height };
    // a scatter-like modifier: every dab moves 250 px right; its reach says so
    const off = registerDabModifier({ id: 'spec-reach', order: 250, enabled: () => true, reach: () => 300, geometry: (d) => [{ ...d, x: d.x + 250 }] });
    const brush = app.tools.get('brush');
    const p = { x: 100, y: 200, pressure: 1, button: 0, buttons: 1 };
    try {
      brush.onPointerDown(p);
      brush.onPointerMove({ ...p, x: 110 }, true);
      brush.onPointerUp({ ...p, x: 110 });
    } finally {
      off();
    }
    const px = (x, y) => layer.canvas.getContext('2d').getImageData(x - layer.x, y - layer.y, 1, 1).data[3];
    // the preview of the stroke view: the same modifier shows
    const preset = normalizeBrush({ tip: { size: 10, hardness: 1 } });
    const plain = renderStrokePreview(preset, {}, { width: 200, height: 64, scale: 1 });
    const off2 = registerDabModifier({ id: 'spec-preview', order: 800, enabled: () => true, buffer: (img) => { for (let i = 3; i < img.data.length; i += 4) img.data[i] = 0; } });
    let erased;
    try {
      erased = renderStrokePreview(preset, {}, { width: 200, height: 64, scale: 1 });
    } finally {
      off2();
    }
    const coverage = (c) => {
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 3; i < d.length; i += 4) n += d[i] > 0 ? 1 : 0;
      return n;
    };
    return { before, after: { x: layer.x, y: layer.y, w: layer.canvas.width, h: layer.canvas.height }, moved: px(355, 200), atPointer: px(105, 200), plain: coverage(plain), erased: coverage(erased), size: [plain.width, plain.height] };
  });
  // the layer grew by the reach (300 px), so the moved dabs landed on it
  expect(r.after.x).toBeLessThanOrEqual(0);
  expect(r.after.x + r.after.w).toBeGreaterThanOrEqual(400);
  expect(r.moved).toBe(255);
  expect(r.atPointer).toBe(0);
  expect(r.size).toEqual([200, 64]);
  expect(r.plain).toBeGreaterThan(200);
  expect(r.erased).toBe(0);
  expect(errors).toEqual([]);
});

test('brush: a Brushes panel pick updates the options bar and the cursor; [ keeps brushPresetId, modified; tool:brush-preset replays with data', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 300, height: 200, background: 'white' });
  await page.evaluate(() => {
    const app = window.pigmentApp;
    app.tools.activate('brush');
    app.panels.show('brushes', { reveal: true });
  });
  await page.locator('.brush-panel .brush-list .brush-item[data-id="hard-45"]').click();
  await expect(page.locator('#options-bar .opt[data-key="size"] input').first()).toHaveValue('45');
  await expect(page.locator('#options-bar button.opt-brush')).toContainText('45 px');
  const pick = await page.evaluate(async () => {
    const app = window.pigmentApp;
    const { toolBrush } = await import('/lib/brush/tool-brush.js');
    const { sectionDiff } = await import('/lib/brush/preset.js');
    await app.presets.ready('brushes');
    const stored = app.presets.get('brushes', 'hard-45').data;
    return { id: app.settings.tools.brush.brushPresetId, size: app.tools.opt('brush', 'size'), hardness: app.tools.opt('brush', 'hardness'), cursor: app.view.canvas.style.cursor, diff: sectionDiff(toolBrush(app, 'brush').preset, stored) };
  });
  expect(pick).toEqual({ id: 'hard-45', size: 45, hardness: 1, cursor: 'none', diff: [] });
  // [ (smaller brush): the tool keeps the preset it came from, now modified
  await page.evaluate(() => document.activeElement?.blur?.());
  await page.keyboard.press('BracketLeft');
  await expect.poll(() => page.evaluate(() => window.pigmentApp.tools.opt('brush', 'size'))).toBe(40);
  await expect(page.locator('#options-bar .opt[data-key="size"] input').first()).toHaveValue('40');
  const after = await page.evaluate(async () => {
    const app = window.pigmentApp;
    const { toolBrush } = await import('/lib/brush/tool-brush.js');
    const { sectionDiff } = await import('/lib/brush/preset.js');
    return { id: app.settings.tools.brush.brushPresetId, diff: sectionDiff(toolBrush(app, 'brush').preset, app.presets.get('brushes', 'hard-45').data) };
  });
  expect(after).toEqual({ id: 'hard-45', diff: ['tip'] });
  // tool:brush-preset by id: recorded with the preset's data, so a replay works without the preset
  const rec = await page.evaluate(async () => {
    const app = window.pigmentApp;
    const done = new Promise((resolve) => {
      const off = app.on('command:done', (ev) => {
        if (ev.id !== 'tool:brush-preset') return;
        off?.();
        resolve(ev);
      });
    });
    await app.commands.run('tool:brush-preset', 'soft-21', 'api');
    const ev = await done;
    return { arg: ev.arg, size: app.tools.opt('brush', 'size'), hardness: app.tools.opt('brush', 'hardness'), id: app.settings.tools.brush.brushPresetId };
  });
  expect(rec.size).toBe(21);
  expect(rec.hardness).toBe(0);
  expect(rec.id).toBe('soft-21');
  expect(rec.arg.id).toBe('soft-21');
  expect(rec.arg.preset.tip.size).toBe(21);
  const replay = await page.evaluate(async (arg) => {
    const app = window.pigmentApp;
    await app.commands.run('tool:brush-preset', { ...arg, id: 'no-such-preset' }, 'action');
    return { size: app.tools.opt('brush', 'size'), id: app.settings.tools.brush.brushPresetId };
  }, rec.arg);
  expect(replay).toEqual({ size: 21, id: 'no-such-preset' });
  expect(errors).toEqual([]);
});

test('brush: a sampled tip given only as a data URL paints after prepareBrush, and its blob joins `brushes`', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 120, height: 80, background: 'transparent' });
  const r = await page.evaluate(async () => {
    const app = window.pigmentApp;
    const { BrushStroke } = await import('/lib/brush.js');
    const { prepareBrush, brushReady, sampleCanvas } = await import('/lib/brush/tool-brush.js');
    const { normalizeBrush } = await import('/lib/brush/preset.js');
    const { createCanvas } = await import('/lib/document.js');
    // a square tip: white (full coverage) on black, 16 x 16
    const tile = document.createElement('canvas');
    tile.width = tile.height = 16;
    const g = tile.getContext('2d');
    g.fillStyle = '#000';
    g.fillRect(0, 0, 16, 16);
    g.fillStyle = '#fff';
    g.fillRect(0, 0, 16, 16);
    const dataUrl = tile.toDataURL('image/png');
    const sampled = normalizeBrush({ tip: { kind: 'sampled', size: 16, hardness: 1, sample: { blob: 'tip-spec-square.png', hash: 'spec-square', width: 16, height: 16, dataUrl } } });
    const history = { stroke: null, beginStroke: (c) => ({ backup: createCanvas(c.width, c.height) }), endStroke: () => null, cancelStroke() {} };
    const paint = (preset) => {
      const canvas = createCanvas(80, 80);
      const s = new BrushStroke({ target: { canvas, x: 0, y: 0 }, layer: null, history, settings: { preset, opacity: 1, flow: 1, smoothing: 0, color: '#000000', mode: 'paint', blend: 'normal' } });
      s.begin({ x: 40, y: 40 });
      s.end();
      const a = (x, y) => canvas.getContext('2d').getImageData(x, y, 1, 1).data[3];
      return { corner: a(33, 33), centre: a(40, 40) };
    };
    const readyBefore = brushReady(sampled);
    await prepareBrush(app, sampled);
    const blob = await app.presets.readBlob('brushes', 'tip-spec-square.png');
    return { readyBefore, readyAfter: brushReady(sampled), decoded: !!sampleCanvas('spec-square'), sampled: paint(sampled), round: paint(normalizeBrush({ tip: { size: 16, hardness: 1 } })), blob: blob?.length ?? 0 };
  });
  expect(r.readyBefore).toBe(false);
  expect(r.readyAfter).toBe(true);
  expect(r.decoded).toBe(true);
  // the square tip covers its corners; the round tip does not
  expect(r.sampled.corner).toBeGreaterThan(200);
  expect(r.round.corner).toBe(0);
  expect(r.sampled.centre).toBe(255);
  expect(r.blob).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

// ---- step 5: PSD mapper registries (S4) ---------------------------------------------------------------------------

const PSD_GOLDEN = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'psd-golden');
// the psdFeatures() flags of the mappers that could write each golden document differently from 0.4 (S15): while all
// are false the file must be 0.4's exactly; after, the document must read back
const PSD_GOLDEN_FLAGS = {
  text: ['textRuns', 'tags'],
  adjustments: ['effects', 'fills', 'tags'],
  masks: ['vectorMasks', 'effects', 'tags'],
  styles: ['effects', 'advancedBlending', 'tags'],
  guides: ['tags', 'globalLight'],
  grayscale: ['textRuns', 'shapes', 'fills', 'tags'],
};

test('psd: the six PSD goldens are written as 0.4 wrote them while their mappers are stubs, and read back after', async ({ page }) => {
  const errors = await openApp(page);
  const features = await page.evaluate(async () => (await import('/lib/psd/registry.js')).psdFeatures());
  await page.evaluate(async () => {
    const { writePsdDocument } = await import('/lib/io.js');
    window.__goldenWritePsd = (d) => (window.__goldenBytes = writePsdDocument(d, d.view.compositor));
  });
  for (const id of PSD_GOLDEN_DOCS) {
    const json = await page.evaluate(pagePsdGolden, id);
    const back = await page.evaluate(async () => {
      const { readPsdDocument } = await import('/lib/io.js');
      const d = window.pigmentApp.doc;
      const names = (doc) => doc.layers().map((l) => l.name);
      return { written: names(d), read: names(readPsdDocument(window.__goldenBytes)) };
    });
    // every layer comes back under its name, in order, whatever the mappers wrote
    expect(back.read, id).toEqual(back.written);
    if (!PSD_GOLDEN_FLAGS[id].some((f) => features[f])) expect(json, `${id}: 0.4's PSD`).toBe(readFileSync(join(PSD_GOLDEN, `${id}.json`), 'utf8').trimEnd());
  }
  expect(errors).toEqual([]);
});

test('psd: a fake shape kind writes natively in RGB and declines in Grayscale, where the shape stays grey pixels', async ({ page }) => {
  const errors = await openApp(page);
  const r = await page.evaluate(async () => {
    const app = window.pigmentApp;
    const { registerPsdLayerKind } = await import('/lib/psd/registry.js');
    const { psdColor } = await import('/lib/psd/convert.js');
    const { writePsdDocument } = await import('/lib/io.js');
    const { ShapeLayer } = await import('/lib/document.js');
    const { readPsd } = await import('ag-psd');
    const seen = [];
    // S4.2's mode rule: a kind that writes colours writes natively only when every colour passes asShown
    const off = registerPsdLayerKind({
      id: 'test-shape',
      order: 340,
      match: (layer) => layer.type === 'shape',
      write(layer, ctx) {
        const color = layer.fill?.color ?? '#000000';
        seen.push({ modeRendered: ctx.modeRendered, asShown: ctx.asShown(color) });
        if (!ctx.asShown(color)) return null;
        ctx.claim(layer, 'shape');
        const p = layer.render();
        return { left: p.x, top: p.y, canvas: ctx.shown(p.canvas, p.x, p.y), vectorFill: { type: 'color', color: psdColor(color) } };
      },
    });
    const rect = { subpaths: [{ closed: true, points: [[10, 10], [50, 10], [50, 40], [10, 40]].map(([x, y]) => ({ x, y, anchor: { x, y }, in: { x, y }, out: { x, y } })) }] };
    const out = {};
    try {
      for (const mode of ['rgb', 'grayscale']) {
        app.newDocument({ width: 60, height: 50, name: mode, mode });
        const d = app.doc;
        const shape = new ShapeLayer({ name: 'Red shape', path: rect, fill: { type: 'solid', color: '#ff0000' } });
        d.add(shape);
        const psd = readPsd(writePsdDocument(d, d.view.compositor), { skipThumbnail: true, skipCompositeImageData: true });
        const rec = psd.children.find((c) => c.name === 'Red shape');
        const px = rec.canvas.getContext('2d').getImageData(20 - rec.left, 20 - rec.top, 1, 1).data;
        out[mode] = { vectorFill: rec.vectorFill?.color ? [rec.vectorFill.color.r, rec.vectorFill.color.g, rec.vectorFill.color.b].map(Math.round) : null, px: Array.from(px) };
      }
    } finally {
      off();
    }
    return { out, seen };
  });
  expect(r.seen).toEqual([{ modeRendered: false, asShown: true }, { modeRendered: true, asShown: false }]);
  expect(r.out.rgb.vectorFill).toEqual([255, 0, 0]);
  expect(r.out.rgb.px).toEqual([255, 0, 0, 255]);
  expect(r.out.grayscale.vectorFill).toBeNull();
  const [gr, gg, gb, ga] = r.out.grayscale.px;
  expect(gr).toBe(gg);
  expect(gg).toBe(gb);
  expect(ga).toBe(255);
  expect(gr).toBeLessThan(200);
  expect(errors).toEqual([]);
});

test('psd: without Maximize Compatibility the composite is blank, not real merged data, and there is no thumbnail', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 40, height: 30, background: 'white' });
  const r = await page.evaluate(async () => {
    const app = window.pigmentApp;
    const d = app.doc;
    const { RasterLayer, createCanvas } = await import('/lib/document.js');
    const { writePsdDocument } = await import('/lib/io.js');
    const { readPsd } = await import('ag-psd');
    const c = createCanvas(40, 30);
    c.getContext('2d').fillStyle = '#204080';
    c.getContext('2d').fillRect(0, 0, 40, 30);
    d.add(new RasterLayer({ name: 'Blue', canvas: c, x: 0, y: 0 }));
    const info = (bytes) => {
      const psd = readPsd(bytes, { skipLayerImageData: true });
      return { thumbnail: !!psd.imageResources?.thumbnail, real: psd.imageResources?.versionInfo?.hasRealMergedData ?? null, px: Array.from(psd.canvas.getContext('2d').getImageData(5, 5, 1, 1).data), layers: psd.children.map((l) => l.name) };
    };
    const out = { on: info(writePsdDocument(d, d.view.compositor)), off: info(writePsdDocument(d, d.view.compositor, { maximizeCompatibility: false })) };
    // without the option, the preference decides: 'never' is off, 'ask' and 'always' are on
    const before = app.settings.psd.maximizeCompatibility;
    app.settings.psd.maximizeCompatibility = 'never';
    out.never = info(writePsdDocument(d, d.view.compositor));
    app.settings.psd.maximizeCompatibility = 'ask';
    out.ask = info(writePsdDocument(d, d.view.compositor));
    app.settings.psd.maximizeCompatibility = before;
    return out;
  });
  expect(r.on).toEqual({ thumbnail: true, real: null, px: [32, 64, 128, 255], layers: ['Background', 'Blue'] });
  expect(r.off).toEqual({ thumbnail: false, real: false, px: [255, 255, 255, 255], layers: ['Background', 'Blue'] });
  expect(r.never).toEqual(r.off);
  expect(r.ask).toEqual(r.on);
  expect(errors).toEqual([]);
});

test('psd: an open notice a mapper reports is shown after the file opens and kept on the document', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 40, height: 30 });
  const notices = await page.evaluate(async () => {
    const app = window.pigmentApp;
    const { registerPsdAspect, registerPsdNotice } = await import('/lib/psd/registry.js');
    const { writePsdDocument } = await import('/lib/io.js');
    window.__pigmentTest.files['mem:/notice.psd'] = writePsdDocument(app.doc, app.doc.view.compositor);
    window.__offNotice = [
      registerPsdNotice('test-dropped', { when: 'open', text: (n, names) => `${n} layer effect${n === 1 ? '' : 's'} Pigment does not have ${n === 1 ? 'was' : 'were'} dropped: ${names.join(', ')}` }),
      registerPsdAspect({ id: 'test-dropped', order: 450, read: (pl, layer, ctx) => ctx.report.add('test-dropped', `Satin on ${layer.name}`) }),
    ];
    await app.commands.run('file:open-paths', ['mem:/notice.psd'], 'api');
    const list = app.doc.openNotices ?? null;
    for (const off of window.__offNotice) off();
    return list;
  });
  expect(notices).toEqual(['1 layer effect Pigment does not have was dropped: Satin on Background']);
  await expect(page.locator('#toasts .toast', { hasText: '1 layer effect Pigment does not have was dropped' })).toBeVisible();
  expect(errors).toEqual([]);
});
