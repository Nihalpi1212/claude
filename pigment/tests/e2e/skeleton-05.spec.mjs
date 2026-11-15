// Pigment 0.5 skeleton smoke spec (port 8850, ARCHITECTURE.md "0.5 features", Part 2). Each step of the skeleton adds
// its tests here: "stubs" (step 2), "keys" (step 3), "brush" (4), "psd" (5), "colour" (6), "camera raw" (7), "colour ui"
// (8), "type" (9), "presets" (10), "toolbox" (11), "start-up" and the exact stub list in "stubs" (12).
//
// Rule 11: this spec stays green before and after each 0.5 package lands. An assertion about a stub's own behaviour
// runs only while the stub is in place, read from the capability flags of S15 (landed() below); the same test checks
// the landed behaviour otherwise.
import { test, expect } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openApp, newDoc, run, runAwait, pixel, confirmDialog, screenPoint } from './helpers.mjs';
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
  // step 12: while no package has landed, app.stubbed is exactly S13.3's stub ids (with 0.6's two of stubs-later.js)
  if (!Object.values(done).some(Boolean)) {
    const stubbed = await page.evaluate(() => [...window.pigmentApp.stubbed].sort());
    const expected = Object.entries(S13_3).filter(([, owner]) => owner !== 'working' && owner !== 'skeleton').map(([id]) => id).sort();
    expect(stubbed).toEqual(expected);
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
    const log = (what, p, extra = {}) => window.__gestureLog.push({ what, button: p?.button, buttons: p?.buttons, alt: !!p?.alt, ctrl: !!p?.ctrl, eraser: !!p?.eraser, barrel: !!p?.barrel, pointerType: p?.pointerType, ...extra });
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

  // the pen's side button pressed while the pen hovers: a right-button drag (button 2 / buttons 2) whose press, moves
  // and release all carry barrel: true (S2.5); a mouse right-drag never does
  await fakeGesture(page, (p) => p.button === 2);
  const side = await page.evaluate(([x, y]) => {
    const canvas = document.querySelector('.doc-frame:not([hidden]) canvas.view');
    // pointerId 1 (the page's active pointer): setPointerCapture throws for an id that is not active
    const drag = (pointerType, pointerId = 1) => {
      window.__gestureLog.length = 0;
      const o = { bubbles: true, cancelable: true, composed: true, pointerId, pointerType, isPrimary: true, clientX: x, clientY: y, pressure: 0 };
      canvas.dispatchEvent(new PointerEvent('pointerdown', { ...o, button: 2, buttons: 2 }));
      canvas.dispatchEvent(new PointerEvent('pointermove', { ...o, clientX: x + 10, button: -1, buttons: 2 }));
      canvas.dispatchEvent(new PointerEvent('pointerup', { ...o, clientX: x + 10, button: 2, buttons: 0 }));
      return window.__gestureLog.map((e) => [e.what, e.barrel]);
    };
    return { pen: drag('pen'), mouse: drag('mouse') };
  }, at(-20, 20));
  expect(side.pen.length).toBeGreaterThanOrEqual(3);
  expect(side.pen.every(([, barrel]) => barrel === true)).toBe(true);
  expect(side.mouse.length).toBeGreaterThan(0);
  expect(side.mouse.every(([, barrel]) => barrel === false)).toBe(true);
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

test('brush: one hard dab at 1000 px and 2500 px keeps 0.4\'s extent and reaches the layer whole (S2.8)', async ({ page }) => {
  const errors = await openApp(page);
  const r = await page.evaluate(async () => {
    const { BrushStroke } = await import('/lib/brush.js');
    const { createCanvas } = await import('/lib/document.js');
    // 0.4's dabCanvas (lib/brush.js at 0.4.0): a canvas of ceil(size) + 2 px, drawn at its own size
    const dab04 = (size) => {
      const d = Math.max(1, Math.ceil(size));
      const c = createCanvas(d + 2, d + 2);
      const ctx = c.getContext('2d');
      const rad = d / 2;
      const g = ctx.createRadialGradient(rad + 1, rad + 1, 0, rad + 1, rad + 1, rad);
      const inner = 0.999;
      g.addColorStop(0, 'rgba(0,0,0,1)');
      g.addColorStop(inner, 'rgba(0,0,0,1)');
      for (let i = 1; i <= 6; i++) {
        const t = i / 6;
        g.addColorStop(Math.min(1, inner + (1 - inner) * t), `rgba(0,0,0,${(1 - t * t * (3 - 2 * t)).toFixed(4)})`);
      }
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, c.width, c.height);
      return c;
    };
    const history = { stroke: null, beginStroke: (c) => ({ backup: createCanvas(c.width, c.height) }), endStroke: () => null, cancelStroke() {} };
    const out = {};
    for (const size of [1000, 2500]) {
      const side = size + 200, cx = side / 2 + 0.5, cy = side / 2 + 0.5;
      const canvas = createCanvas(side, side);
      const s = new BrushStroke({ target: { canvas, x: 0, y: 0 }, layer: null, history, settings: { size, hardness: 1, opacity: 1, flow: 1, smoothing: 0, color: '#000000', mode: 'paint', blend: 'normal' } });
      s.begin({ x: cx, y: cy });
      s.end();
      const ref = createCanvas(side, side);
      const dab = dab04(size);
      ref.getContext('2d').drawImage(dab, cx - dab.width / 2, cy - dab.height / 2);
      const row = (c) => c.getContext('2d').getImageData(0, Math.floor(cy), side, 1).data;
      const col = (c) => c.getContext('2d').getImageData(Math.floor(cx), 0, 1, side).data;
      // the opaque reach from the centre in each direction (alpha > 0), and the sum of alpha along the two axes
      const reach = (d) => {
        let lo = -1, hi = -1, sum = 0;
        for (let i = 0; i < side; i++) {
          const a = d[i * 4 + 3];
          sum += a;
          if (a > 0) {
            if (lo < 0) lo = i;
            hi = i;
          }
        }
        return { lo, hi, sum };
      };
      out[size] = { got: [reach(row(canvas)), reach(col(canvas))], ref: [reach(row(ref)), reach(col(ref))], dirty: s.dirty && [s.dirty.width, s.dirty.height] };
    }
    return out;
  });
  for (const size of [1000, 2500]) {
    const { got, ref, dirty } = r[size];
    for (let axis = 0; axis < 2; axis++) {
      // the dab ends where 0.4's ended (the resampled 1 % step canvas may move the last soft edge pixel by one)
      expect(Math.abs(got[axis].lo - ref[axis].lo)).toBeLessThanOrEqual(1);
      expect(Math.abs(got[axis].hi - ref[axis].hi)).toBeLessThanOrEqual(1);
      expect(Math.abs(got[axis].sum - ref[axis].sum) / ref[axis].sum).toBeLessThan(0.002);
    }
    // nothing outside the dirty rect: it holds the whole dab
    expect(dirty[0]).toBeGreaterThanOrEqual(got[0].hi - got[0].lo + 1);
  }
  expect(errors).toEqual([]);
});

test('brush: 0.4\'s settings.brushPresets migrate once into `brushes` under their own ids (S1.2)', async ({ page }) => {
  const errors = await openApp(page);
  const old = [
    { id: 'my-old-brush', name: 'My Old Brush', size: 33, hardness: 0.5, spacing: 0.2, angle: 30, roundness: 0.6, flow: 0.4 },
    { id: 'hard', name: 'Hard', size: 12, hardness: 1 },
  ];
  await page.addInitScript((presets) => localStorage.setItem('pigment.settings', JSON.stringify({ brushPresets: presets, brushes: { migrated: false } })), old);
  await page.reload();
  await page.waitForSelector('body[data-ready]');
  const read = () =>
    page.evaluate(async () => {
      const app = window.pigmentApp;
      await app.presets.ready('brushes');
      const list = app.presets.list('brushes');
      const at = (id) => list.findIndex((p) => p.id === id);
      const get = (id) => {
        const p = app.presets.get('brushes', id);
        return p && { name: p.name, tip: [p.data.tip.size, p.data.tip.hardness, p.data.tip.spacing, p.data.tip.angle, p.data.tip.roundness], flow: p.data.tool?.flow };
      };
      return {
        ids: list.map((p) => p.id), lastBuiltin: Math.max(...list.filter((p) => p.builtin).map((p) => at(p.id))), mine: at('my-old-brush'), hard: at('hard'),
        a: get('my-old-brush'), b: get('hard'), migrated: app.settings.brushes?.migrated, kept: (app.settings.brushPresets ?? []).map((p) => p.id),
      };
    });
  await expect.poll(async () => (await read()).migrated).toBe(true);
  const first = await read();
  expect(first.mine).toBeGreaterThan(first.lastBuiltin);
  expect(first.hard).toBe(first.mine + 1);
  expect(first.a).toEqual({ name: 'My Old Brush', tip: [33, 0.5, 0.2, 30, 0.6], flow: 0.4 });
  expect(first.b.tip.slice(0, 2)).toEqual([12, 1]);
  expect(first.b.flow).toBe(1);
  expect(first.kept).toEqual(['my-old-brush', 'hard']);
  // a second start with what the first one saved adds nothing
  await page.evaluate(() => window.pigmentApp.presets.flush());
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('pigment.settings') ?? '{}').brushes?.migrated)).toBe(true);
  const saved = await page.evaluate(() => localStorage.getItem('pigment.settings'));
  await page.addInitScript((s) => localStorage.setItem('pigment.settings', s), saved);
  await page.reload();
  await page.waitForSelector('body[data-ready]');
  const second = await read();
  expect(second.ids).toEqual(first.ids);
  expect(second.ids.filter((id) => id === 'my-old-brush' || id === 'hard')).toEqual(['my-old-brush', 'hard']);
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

// ---- step 6: chunks, colour, saving and opening (S5, S6, S12.3, S12.6) --------------------------------------------

/** In the page: a fake colour engine (icc-engine's role) that adopts any embedded profile and marks what it is asked. */
async function fakeEngine(page, { space = 'srgb' } = {}) {
  await page.evaluate(async (displaySpace) => {
    const P = await import('/lib/color/pipeline.js');
    const FAKE = (bytes) => ({ id: `fake-${bytes.length}`, name: 'Fake P3', bytes, colorSpace: 'rgb', wellKnown: null, source: 'embedded' });
    const asked = (window.__engineAsked = { decode: [], adopt: [] });
    P.setColorEngine({
      id: 'fake', available: true, ready: () => Promise.resolve(),
      parse: (bytes) => (bytes?.length ? FAKE(new Uint8Array(bytes)) : null),
      builtins: () => [P.SRGB], profiles: async () => [P.SRGB],
      transform: () => ({ identity: true, apply() {} }),
      decodeConversion(chunks, format) {
        asked.decode.push({ format, icc: !!chunks.icc });
        return chunks.icc ? 'none' : 'default';
      },
      adoptOnOpen(doc, { chunks, format, conv }) {
        asked.adopt.push({ format, conv });
        if (conv === 'none' && chunks.icc) doc.profile = FAKE(chunks.icc);
      },
      displaySpace: () => displaySpace,
    });
    await new Promise((r) => setTimeout(r, 0));
  }, space);
}

test('colour: every save and export of an untagged document is byte-identical to 0.4\'s (no chunk provider)', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 64, height: 48, background: 'white' });
  const r = await page.evaluate(async () => {
    const app = window.pigmentApp;
    const d = app.doc;
    const comp = d.view.compositor;
    const io = await import('/lib/io.js');
    const { flattenDocument } = await import('/lib/compositor.js');
    const { chunkProviders, readChunks } = await import('/lib/io-chunks.js');
    const { createCanvas } = await import('/lib/document.js');
    // one layer, so Save As writes the PNG without asking to flatten
    const g = d.active.canvas.getContext('2d');
    g.fillStyle = '#c04020';
    g.fillRect(8, 6, 40, 30);
    g.fillStyle = 'rgba(20, 80, 200, 0.5)';
    g.fillRect(18, 11, 20, 20);
    d.active.touch();
    const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
    const blob = async (canvas, mime, q) => new Uint8Array(await (await new Promise((res) => canvas.toBlob(res, mime, q))).arrayBuffer());
    // 0.4's exportImage for the built-in formats: the flattened document, JPEG on white, quality 0.92
    const flat = flattenDocument(d, comp);
    const onWhite = createCanvas(d.width, d.height);
    onWhite.getContext('2d').fillStyle = '#ffffff';
    onWhite.getContext('2d').fillRect(0, 0, d.width, d.height);
    onWhite.getContext('2d').drawImage(flat, 0, 0);
    const out = { providers: chunkProviders().length, profile: d.profile, described: d.describe().profile };
    out.png = same(await io.encodeForPath(d, 'x.png', comp), await blob(flat, 'image/png'));
    out.jpeg = same(await io.encodeForPath(d, 'x.jpg', comp, { quality: 0.92 }), await blob(onWhite, 'image/jpeg', 0.92));
    out.webp = same(await io.exportImage(d, { format: 'webp' }, comp), await blob(flat, 'image/webp', 0.92));
    out.psd = same(await io.encodeForPath(d, 'x.psd', comp), io.writePsdDocument(d, comp));
    // the registered encoders (16-bit PNG, TIFF, TGA, GIF, PNG-8) through exportImage: what the encoder returned
    out.registered = {};
    for (const id of ['png16', 'tiff', 'tga', 'gif', 'png8']) {
      const f = io.SAVE_FORMATS[id];
      if (f?.encode) out.registered[id] = same(await io.exportImage(d, { format: id }, comp), await f.encode(d, { format: id }, comp));
    }
    // a save through the document manager writes the same PNG
    window.__pigmentTest.nextSavePath = 'mem:/untagged.png';
    await app.commands.run('file:save-as', undefined, 'api');
    out.saved = same(window.__pigmentTest.written['mem:/untagged.png'], await blob(flat, 'image/png'));
    out.savedChunks = Object.keys(await readChunks(window.__pigmentTest.written['mem:/untagged.png'], 'png'));
    const { readZip } = await import('/shared/zip.js');
    const { streamCodecs } = await import('/shared/zip.js');
    const entries = await readZip(await io.writePigment(d), { inflate: streamCodecs.inflate });
    out.pigmentEntries = entries.map((e) => e.name).filter((n) => /profile/.test(n));
    return out;
  });
  expect(r.providers).toBe(0);
  expect(r.profile).toBeNull();
  expect(r.described).toBeNull();
  expect(r).toMatchObject({ png: true, jpeg: true, webp: true, psd: true, saved: true });
  expect(Object.values(r.registered).length).toBeGreaterThanOrEqual(3);
  for (const [id, ok] of Object.entries(r.registered)) expect(ok, id).toBe(true);
  expect(r.savedChunks).toEqual([]); // the browser's PNG carries no metadata chunk, and nothing was added
  expect(r.pigmentEntries).toEqual([]);
  expect(errors).toEqual([]);
});

test('colour: with a fake engine a PNG\'s profile is adopted and re-embedded on save, Export As and copy; a soft-alpha palette PNG reaches its reader with the engine\'s conv', async ({ page }) => {
  const errors = await openApp(page);
  await fakeEngine(page);
  const r = await page.evaluate(async () => {
    const app = window.pigmentApp;
    const T = window.__pigmentTest;
    const { writeChunks, readChunks, registerChunkProvider } = await import('/lib/io-chunks.js');
    const { encodePng } = await import('/shared/pixels/png.js');
    const ICC = Uint8Array.from({ length: 700 }, (_, i) => (i * 11 + 5) & 255);
    // the 'icc' provider as icc-engine registers it: the document's profile bytes, unless converted to sRGB
    const purposes = [];
    registerChunkProvider({ id: 'icc', order: 100, kinds: ['icc'], provide: (doc, { purpose, opts }) => (purposes.push(purpose), doc?.profile?.bytes && opts?.convertTo !== 'srgb' && opts?.embedProfile !== false ? { icc: doc.profile.bytes } : null) });
    const c = document.createElement('canvas');
    c.width = 30;
    c.height = 20;
    c.getContext('2d').fillStyle = '#3366cc';
    c.getContext('2d').fillRect(0, 0, 30, 20);
    const png = new Uint8Array(await (await new Promise((res) => c.toBlob(res, 'image/png'))).arrayBuffer());
    T.files['mem:/tagged.png'] = await writeChunks(png, 'png', { icc: ICC });
    // what the browser decoder is asked: the conversion openDocument chose
    const bitmaps = [];
    const create = window.createImageBitmap;
    window.createImageBitmap = (src, ...rest) => {
      const o = rest.find((x) => x && typeof x === 'object');
      bitmaps.push(o?.colorSpaceConversion ?? null);
      return create.call(window, src, ...rest);
    };
    await app.commands.run('file:open-paths', ['mem:/tagged.png'], 'api');
    const d = app.doc;
    const out = { adopted: d.profile?.name ?? null, bytes: d.profile?.bytes?.length ?? 0, asked: JSON.parse(JSON.stringify(window.__engineAsked)), bitmaps: bitmaps.slice() };
    const has = async (bytes, f) => {
      const ch = await readChunks(bytes, f);
      return !!ch.icc && ch.icc.length === ICC.length && ch.icc.every((v, i) => v === ICC[i]);
    };
    T.nextSavePath = 'mem:/saved.png';
    await app.commands.run('file:save-as', undefined, 'api');
    out.saved = await has(T.written['mem:/saved.png'], 'png');
    await app.commands.run('file:export', { path: 'mem:/exported.jpg', format: 'jpeg', quality: 0.9, width: 30, height: 20 }, 'api');
    out.exported = await has(T.written['mem:/exported.jpg'], 'jpeg');
    // a clipboard copy: the PNG handed to the system clipboard
    let copied = null;
    navigator.clipboard.write = async (items) => {
      copied = new Uint8Array(await (await items[0].getType('image/png')).arrayBuffer());
    };
    await app.commands.run('edit:copy-merged', undefined, 'api');
    out.copied = copied ? await has(copied, 'png') : null;
    out.purposes = [...new Set(purposes)];
    // a soft-alpha palette PNG (no single transparent index) opens through the browser decoder: once, with 'none'
    bitmaps.length = 0;
    window.__engineAsked.decode.length = 0;
    const idx = await encodePng({ width: 2, height: 2, channels: 1, depth: 8, data: Uint8Array.of(0, 1, 1, 0), palette: Uint8Array.of(255, 0, 0, 0, 0, 255), transparency: Uint8Array.of(128, 200) }, { indexed: true });
    T.files['mem:/soft.png'] = await writeChunks(idx, 'png', { icc: ICC });
    await app.commands.run('file:open-paths', ['mem:/soft.png'], 'api');
    out.soft = { bitmaps: bitmaps.slice(), decode: window.__engineAsked.decode.slice(), profile: !!app.doc.profile, mode: app.doc.mode };
    window.createImageBitmap = create;
    return out;
  });
  expect(r.adopted).toBe('Fake P3');
  expect(r.bytes).toBe(700);
  expect(r.asked.decode).toEqual([{ format: 'png', icc: true }]);
  expect(r.asked.adopt).toEqual([{ format: 'png', conv: 'none' }]);
  expect(r.bitmaps).toContain('none');
  expect(r.bitmaps).not.toContain('default');
  expect(r).toMatchObject({ saved: true, exported: true, copied: true });
  expect(r.purposes).toEqual(expect.arrayContaining(['save', 'export', 'copy']));
  expect(r.soft.decode).toEqual([{ format: 'png', icc: true }]);
  expect(r.soft.bitmaps).toEqual(['none']);
  expect(r.soft.profile).toBe(true);
  expect(r.soft.mode).toBe('rgb');
  expect(errors).toEqual([]);
});

test('colour: Assign Profile is one entry that undoes and survives .pigment; the status bar and Info show the profile only with an engine', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 40, height: 30 });
  const before = await page.evaluate(() => ({ status: !!document.querySelector('#statusbar [data-key="profile"]:not([hidden])'), info: document.querySelector('.info-panel [data-k="profile"]')?.hidden ?? true }));
  expect(before).toEqual({ status: false, info: true });
  await fakeEngine(page);
  const r = await page.evaluate(async () => {
    const app = window.pigmentApp;
    const d = app.doc;
    const P = await import('/lib/color/pipeline.js');
    const io = await import('/lib/io.js');
    const profile = P.colorEngine().parse(Uint8Array.from({ length: 64 }, (_, i) => i));
    const n = d.history.entries.length;
    P.assignProfile(app, d, profile, 'Assign Profile');
    const out = { entries: d.history.entries.length - n, label: d.history.entries.at(-1).label, after: d.profile?.id };
    await new Promise((res) => setTimeout(res, 200));
    out.status = document.querySelector('#statusbar [data-key="profile"]')?.textContent ?? null;
    d.history.undo();
    out.undone = d.profile;
    d.history.redo();
    out.redone = d.profile?.id;
    const back = await io.readPigment(await io.writePigment(d));
    out.pigment = { id: back.profile?.id, bytes: back.profile?.bytes?.length ?? 0, name: back.profile?.name };
    const dup = await app.commands.run('image:duplicate', { name: 'Copy' }, 'api');
    void dup;
    out.duplicate = app.doc.profile?.id ?? null;
    return out;
  });
  expect(r).toMatchObject({ entries: 1, label: 'Assign Profile', after: 'fake-64', undone: null, redone: 'fake-64', pigment: { id: 'fake-64', bytes: 64, name: 'Fake P3' }, duplicate: 'fake-64' });
  expect(r.status).toBe('Fake P3');
  expect(errors).toEqual([]);
});

test('colour: a display stage converts the damage only, and a sampleMerged call between two paints loses no region', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 200, height: 150, background: 'white' });
  const r = await page.evaluate(async () => {
    const app = window.pigmentApp;
    const d = app.doc;
    const view = d.view;
    const P = await import('/lib/color/pipeline.js');
    const frame = () => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
    // the stage inverts colours into a kept copy of the composite, converting only the damage it is handed
    const calls = [];
    let kept = null;
    const convert = (src, rect) => {
      const g = kept.getContext('2d', { willReadFrequently: true });
      const img = src.getContext('2d', { willReadFrequently: true }).getImageData(rect.x, rect.y, rect.width, rect.height);
      for (let i = 0; i < img.data.length; i += 4) for (let k = 0; k < 3; k++) img.data[i + k] = 255 - img.data[i + k];
      g.putImageData(img, rect.x, rect.y);
    };
    const off = P.registerDisplayStage({
      id: 'test-invert', order: 900, active: (v) => v === view,
      apply(canvas, v, { damage, scratch }) {
        calls.push(scratch ? 'scratch' : damage === 'full' ? 'full' : damage ? [damage.x, damage.y, damage.width, damage.height] : null);
        if (scratch) return canvas;
        if (!kept || kept.width !== canvas.width || kept.height !== canvas.height || damage === 'full') {
          kept = document.createElement('canvas');
          kept.width = canvas.width;
          kept.height = canvas.height;
          convert(canvas, { x: 0, y: 0, width: canvas.width, height: canvas.height });
        } else if (damage) convert(canvas, damage);
        return kept;
      },
    });
    view.invalidate();
    await frame();
    const layer = d.active;
    const paint = (x, y, color) => {
      layer.canvas.getContext('2d').fillStyle = color;
      layer.canvas.getContext('2d').fillRect(x, y, 10, 10);
      layer.touch();
      view.invalidate({ x, y, width: 10, height: 10 }, layer); // a brush dab's hint: a region repaint
    };
    paint(20, 20, '#ff0000');
    await frame();
    // A changes, someone composites (the Info panel's sampler) before the view paints, then B changes
    paint(100, 60, '#00ff00');
    app.sampleMerged(d);
    paint(150, 100, '#0000ff');
    await frame();
    // the kept copy is the inverted composite everywhere
    const comp = view.compositor.composite(d).getContext('2d', { willReadFrequently: true }).getImageData(0, 0, d.width, d.height).data;
    const shown = kept.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, d.width, d.height).data;
    let wrong = 0;
    for (let i = 0; i < comp.length; i += 4) if (shown[i] !== 255 - comp[i] || shown[i + 1] !== 255 - comp[i + 1] || shown[i + 2] !== 255 - comp[i + 2]) wrong++;
    off();
    return { calls, wrong };
  });
  expect(r.calls[0]).toBe('full');
  // after the first paint every conversion is a region: never the whole document again
  const later = r.calls.slice(1).filter((c) => c !== null);
  expect(later.length).toBeGreaterThanOrEqual(2);
  for (const c of later) expect(Array.isArray(c), JSON.stringify(c)).toBe(true);
  // the last one covers both changes after the first paint (A, composited by sampleMerged, and B)
  const last = later.at(-1);
  expect(last[0]).toBeLessThanOrEqual(100);
  expect(last[0] + last[2]).toBeGreaterThanOrEqual(160);
  expect(r.wrong).toBe(0);
  expect(errors).toEqual([]);
});

test('colour: a display space change swaps the view canvas, which still takes pointer input', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 120, height: 90, background: 'white' });
  const old = await page.evaluate(() => {
    window.__oldCanvas = window.pigmentApp.view.canvas;
    return window.pigmentApp.view.ctx.getContextAttributes().colorSpace;
  });
  expect(old).toBe('srgb');
  await fakeEngine(page, { space: 'display-p3' });
  const r = await page.evaluate(() => {
    const v = window.pigmentApp.view;
    return { swapped: v.canvas !== window.__oldCanvas, inDom: v.canvas.isConnected && !window.__oldCanvas.isConnected, space: v.ctx.getContextAttributes().colorSpace, cls: v.canvas.className };
  });
  expect(r).toEqual({ swapped: true, inDom: true, space: 'display-p3', cls: 'view' });
  // the Brush paints through the new element
  await runAwait(page, 'tool:brush');
  await page.evaluate(() => window.pigmentApp.setColors({ foreground: '#000000' }));
  const box = await page.locator('.doc-frame:not([hidden]) canvas.view').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 20, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
  expect(await page.evaluate(() => window.pigmentApp.doc.history.entries.at(-1).label)).toMatch(/Brush/);
  expect(errors).toEqual([]);
});

test('colour: an open hook sees interactive from Open, not from Batch, and does not run for New or Duplicate', async ({ page }) => {
  const errors = await openApp(page);
  const r = await page.evaluate(async () => {
    const app = window.pigmentApp;
    const T = window.__pigmentTest;
    const { registerOpenHook } = await import('/lib/documents.js');
    const M = await import('/lib/actions/model.js');
    const seen = [];
    const off = registerOpenHook((doc, info) => {
      seen.push({ name: doc.name, path: info.path, format: info.format, interactive: info.interactive });
      if (!info.interactive) info.notice(`checked ${doc.name}`);
    });
    const png = async (color) => {
      const c = document.createElement('canvas');
      c.width = 8;
      c.height = 6;
      c.getContext('2d').fillStyle = color;
      c.getContext('2d').fillRect(0, 0, 8, 6);
      return new Uint8Array(await (await new Promise((res) => c.toBlob(res, 'image/png'))).arrayBuffer());
    };
    T.files['mem:/one.png'] = await png('#ff0000');
    await app.commands.run('file:open-paths', ['mem:/one.png'], 'api');
    app.newDocument({ width: 10, height: 10, name: 'New' });
    await app.commands.run('image:duplicate', { name: 'Dup' }, 'api');
    for (const n of ['a', 'b']) T.files[`mem:/batch/${n}.png`] = await png('#00ff00');
    const set = M.makeSet('Hooks');
    set.actions.push(M.makeAction('Flip', [M.makeStep('image:flip-h')]));
    app.actions.sets.push(set);
    const summary = await app.commands.run('file:automate-batch', { set: 'Hooks', action: 'Flip', source: 'folder', folder: 'mem:/batch', destination: 'none', errors: 'log', logFile: 'mem:/batch.log' }, 'api');
    off();
    return { seen, processed: summary?.processed, notes: summary?.notes, log: T.written['mem:/batch.log'] ? new TextDecoder().decode(T.written['mem:/batch.log']) : null };
  });
  expect(r.seen).toEqual([
    { name: 'one', path: 'mem:/one.png', format: 'png', interactive: true },
    { name: 'a', path: 'mem:/batch/a.png', format: 'png', interactive: false },
    { name: 'b', path: 'mem:/batch/b.png', format: 'png', interactive: false },
  ]);
  expect(r.processed).toBe(2);
  expect(r.notes.map((n) => n.message)).toEqual(['checked a', 'checked b']);
  expect(r.log).toContain('checked a');
  expect(errors).toEqual([]);
});

// ---- step 7: Camera Raw stages and registry, Last Filter for commands (S8, S12.4) -----------------------------------

/** Fills the active layer with one colour (no history entry). */
const fillLayer = (page, color) =>
  page.evaluate((c) => {
    const l = window.pigmentApp.doc.active;
    const ctx = l.canvas.getContext('2d');
    ctx.fillStyle = c;
    ctx.fillRect(0, 0, l.canvas.width, l.canvas.height);
    l.touch();
    window.pigmentApp.doc.changed('pixels', { layer: l });
  }, color);

test('camera raw: a stage, a section and a tool registered in the page appear in the dialog and drive the preview', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  await fillLayer(page, '#808080');
  const done = await landed(page);
  await page.evaluate(async () => {
    const S = await import('/shared/pixels/develop-stages.js');
    const R = await import('/lib/develop/registry.js');
    // a perceptual stage that paints the image a flat red at 100 %, owning its own top-level key
    window.__crOff = [
      S.registerDevelopStage({
        id: 'test-red', order: 560, space: 'perceptual',
        params: { keys: ['testRed'], defaults: () => ({ testRed: { amount: 0 } }), normalize: (p) => ({ testRed: { amount: 0, ...(p.testRed ?? {}) } }) },
        neutral: (p) => !p.testRed.amount,
        apply({ R: r, G, B }, p) {
          const k = p.testRed.amount / 100;
          for (let i = 0; i < r.length; i++) {
            r[i] += (1 - r[i]) * k;
            G[i] -= G[i] * k;
            B[i] -= B[i] * k;
          }
        },
      }),
      R.registerDevelopSection({ tab: 'basic', id: 'test-red', label: 'Test red', order: 900, fields: [{ key: 'testRed.amount', label: 'Red', type: 'slider', min: 0, max: 100, step: 1 }] }),
      R.registerDevelopTab({ id: 'test-tab', label: 'Test tab', order: 950 }),
      R.registerDevelopSection({ tab: 'test-tab', id: 'custom', label: 'Custom', order: 1, render: (ctx) => {
        const b = document.createElement('button');
        b.className = 'test-custom';
        b.textContent = 'Half red';
        b.addEventListener('click', () => ctx.set('testRed.amount', 50));
        return b;
      } }),
      R.registerDevelopTool({ id: 'test-tool', label: 'Probe', icon: 'eyedropper', order: 10, cursor: 'crosshair', activate: (ws) => { window.__crTool = { active: true, red: ws.get('testRed.amount') }; }, down() {} }),
    ];
  });
  await run(page, 'filter:camera-raw');
  await expect(page.locator('.dialog .camera-raw')).toBeVisible();
  // 0.4's tab ids stay, the registered tab follows them; the registered section's field sits in Basic
  const tabs = await page.locator('.dialog .dialog-tab').evaluateAll((els) => els.map((el) => el.dataset.tab));
  expect(tabs).toEqual(expect.arrayContaining(['basic', 'detail', 'hsl', 'effects', 'test-tab']));
  if (!done['camera-raw-panels']) expect(tabs).toEqual(['basic', 'detail', 'hsl', 'effects', 'test-tab']);
  await page.locator('.dialog input[type="number"][data-key="testRed.amount"]').fill('100');
  await expect.poll(async () => (await pixel(page, 200, 150)).slice(0, 3)).toEqual([255, 0, 0]);
  // a rendered section sets a param through ctx.set: the form follows and the preview updates
  await page.locator('.dialog .dialog-tab[data-tab="test-tab"]').click();
  await page.locator('.dialog .test-custom').click();
  await expect(page.locator('.dialog input[type="number"][data-key="testRed.amount"]')).toHaveValue('50');
  await expect.poll(async () => (await pixel(page, 200, 150))[1]).toBeLessThan(100);
  // the registered tool has a button in the dialog's tool strip and gets a workspace when activated
  await page.locator('.dialog .camera-raw [data-tool="test-tool"]').click();
  expect(await page.evaluate(() => window.__crTool)).toEqual({ active: true, red: 50 });
  await confirmDialog(page);
  const r = await page.evaluate(() => {
    const d = window.pigmentApp.doc;
    for (const off of window.__crOff) off();
    return { label: d.history.entries[d.history.index].label };
  });
  expect(r.label).toBe('Camera Raw');
  expect((await pixel(page, 200, 150))[0]).toBeGreaterThan(180);
  expect(errors).toEqual([]);
});

test('camera raw: a fake kind\'s open runs for a new and a re-edited smart filter, each one entry; the stub dialog keeps 0.4\'s smart kind', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  await fillLayer(page, '#808080');
  await runAwait(page, 'layer:smart-convert');
  const r = await page.evaluate(async () => {
    const app = window.pigmentApp;
    const d = app.doc;
    const layer = d.active;
    const calls = [];
    app.smartFilters.registerKind('test-open', {
      name: 'Test Open',
      defaults: () => ({ amount: 1 }),
      apply: (img) => img,
      editor: () => ({ element: document.createElement('div') }),
      geometric: (p) => p.amount > 5,
      recolourOnly: () => true,
      async open(l, params, { index, label }) {
        // the kind previews through layer.filters; the module puts them back and records the entry
        calls.push({ same: l === layer, params, index, label });
        l.filters = [...l.filters, { kind: 'test-open', params: { amount: 99 }, enabled: true }];
        return { amount: params.amount + 1 };
      },
    });
    const n0 = d.history.index;
    const added = await app.smartFilters.intercept(layer, 'test-open', null, 'Test Open').done;
    const n1 = d.history.index;
    const entry1 = d.history.entries[n1].label;
    const filters1 = JSON.parse(JSON.stringify(layer.filters));
    const edited = await app.smartFilters.edit(layer, 0);
    const n2 = d.history.index;
    return { calls, added, edited, steps: [n1 - n0, n2 - n1], entry1, entry2: d.history.entries[n2].label, filters1, filters2: JSON.parse(JSON.stringify(layer.filters)) };
  });
  expect(r.calls).toEqual([
    { same: true, params: { amount: 1 }, index: -1, label: 'Test Open' },
    { same: true, params: { amount: 2 }, index: 0, label: 'Test Open' },
  ]);
  expect(r.added).toEqual({ amount: 2 });
  expect(r.edited).toEqual({ amount: 3 });
  expect(r.steps).toEqual([1, 1]);
  expect(r.entry1).toBe('Smart filter: Test Open');
  expect(r.entry2).toBe('Edit smart filter: Test Open');
  expect(r.filters1).toEqual([{ kind: 'test-open', params: { amount: 2 }, enabled: true }]);
  expect(r.filters2).toEqual([{ kind: 'test-open', params: { amount: 3 }, enabled: true }]);
  // the skeleton's Camera Raw kind: geometric, recolour-only and 48 px of padding (0.4's results)
  const kind = await page.evaluate(async () => {
    const { isGeometricFilter, filterPadding } = await import('/lib/smart-object.js');
    return { geometric: isGeometricFilter({ kind: 'camera-raw', params: {} }), pad: filterPadding([{ kind: 'camera-raw', params: { exposure: 1 } }]), fake: [isGeometricFilter({ kind: 'test-open', params: { amount: 1 } }), isGeometricFilter({ kind: 'test-open', params: { amount: 9 } })] };
  });
  expect(kind.geometric).toBe(true);
  expect(kind.fake).toEqual([false, true]);
  // the skeleton's padding (camera-raw-workspace owns develop-ui.js afterwards)
  if (!(await landed(page))['camera-raw-workspace']) expect(kind.pad).toBe(48);
  expect(errors).toEqual([]);
});

test('camera raw: a stage that needs the whole layer restarts the session without the selection, which masks the result', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  await fillLayer(page, '#808080');
  await page.evaluate(async () => {
    const app = window.pigmentApp;
    const { Selection } = await import('/lib/selection.js');
    const d = app.doc;
    d.selection = Selection.fromRect(d.width, d.height, { x: 0, y: 0, width: 100, height: 300 });
    d.changed('selection');
    const S = await import('/shared/pixels/develop-stages.js');
    window.__crSeen = [];
    window.__crOff = S.registerDevelopStage({
      id: 'test-whole', order: 70, space: 'resample',
      params: { keys: ['testWhole'], defaults: () => ({ testWhole: 0 }) },
      neutral: (p) => !p.testWhole,
      margin: () => Infinity,
      apply({ R, G, B, w, h }) {
        window.__crSeen.push([w, h]);
        R.fill(1);
        G.fill(0);
        B.fill(0);
      },
    });
  });
  await page.evaluate(async () => {
    const R = await import('/lib/develop/registry.js');
    window.__crOff2 = R.registerDevelopSection({ tab: 'basic', id: 'test-whole', label: '', order: 950, fields: [{ key: 'testWhole', label: 'Whole', type: 'number', min: 0, max: 1 }] });
  });
  await run(page, 'filter:camera-raw');
  await page.locator('.dialog input[type="number"][data-key="testWhole"]').fill('1');
  await expect.poll(async () => (await pixel(page, 50, 150)).slice(0, 3)).toEqual([255, 0, 0]);
  await confirmDialog(page);
  const seen = await page.evaluate(() => {
    window.__crOff();
    window.__crOff2();
    return window.__crSeen.at(-1);
  });
  // the stage saw the whole 400 x 300 layer; outside the selection the pixels stay grey
  expect(seen).toEqual([400, 300]);
  expect((await pixel(page, 50, 150)).slice(0, 3)).toEqual([255, 0, 0]);
  expect((await pixel(page, 300, 150)).slice(0, 3)).toEqual([128, 128, 128]);
  expect(errors).toEqual([]);
});

test('camera raw: Last Filter repeats a remembered command without its dialog and records one step with its params; Last Filter Dialog opens it prefilled', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  await fillLayer(page, '#808080');
  const r = await page.evaluate(async () => {
    const app = window.pigmentApp;
    const seen = [];
    app.commands.register('test:remembered', { label: 'Remembered', dialog: true, run: (arg, ctx) => { seen.push({ arg, source: ctx.source }); ctx.setReplayArg(arg); return arg; } });
    app.filterEditor.rememberCommand('test:remembered', 'Remembered', { amount: 7 });
    app.actions.record(app.actions.newAction({ name: 'Repeat' }));
    await app.commands.run('filter:last', undefined, 'api');
    await new Promise((res) => setTimeout(res, 50));
    const steps = app.actions.recording.action.steps.map((s) => ({ cmd: s.command, arg: s.arg }));
    app.actions.stopRecording();
    return { seen, steps, last: app.settings.lastFilter, menu: app.uiState.lastFilter };
  });
  expect(r.seen).toEqual([{ arg: { amount: 7 }, source: 'repeat' }]);
  expect(r.last).toEqual({ command: 'test:remembered', name: 'Remembered', params: { amount: 7 } });
  expect(r.steps).toEqual([{ cmd: 'test:remembered', arg: { amount: 7 } }]);
  expect(r.menu).toBe('Remembered'); // the native menu reads "Last Filter: Remembered"

  // Camera Raw remembered: Last Filter applies it without a dialog, Last Filter Dialog opens it prefilled
  const before = (await pixel(page, 200, 150))[0];
  await page.evaluate(() => window.pigmentApp.filterEditor.rememberCommand('filter:camera-raw', 'Camera Raw', { exposure: 1.5 }));
  await runAwait(page, 'filter:last');
  await expect(page.locator('.dialog-backdrop')).toHaveCount(0);
  await page.waitForFunction(() => !document.body.classList.contains('busy'));
  const after = (await pixel(page, 200, 150))[0];
  expect(after).toBeGreaterThan(before + 40);
  expect(await page.evaluate(() => window.pigmentApp.doc.history.entries[window.pigmentApp.doc.history.index].label)).toBe('Camera Raw');
  await run(page, 'filter:last-dialog');
  await expect(page.locator('.dialog .camera-raw')).toBeVisible();
  await expect(page.locator('.dialog input[type="number"][data-key="exposure"]')).toHaveValue('1.5');
  await page.locator('.dialog-backdrop .dialog-buttons button[data-value="null"]').last().click();
  await expect(page.locator('.dialog-backdrop')).toHaveCount(0);
  expect((await pixel(page, 200, 150))[0]).toBe(after);
  expect(errors).toEqual([]);
});

// ---- step 8: colour UI (S7) --------------------------------------------------------------------------------------

test('colour ui: a registered color widget appears in a dialog form, the options bar, the gradient field and the Character panel', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  await page.evaluate(async () => {
    const { registerWidget } = await import('/lib/fields.js');
    // a fake real widget: a swatch button keeping a (hidden) colour input with the field's data-key (S7.3)
    registerWidget('color', (spec, { value, onInput, onChange }) => {
      const wrap = document.createElement('span');
      wrap.className = 'fake-color';
      const input = document.createElement('input');
      input.type = 'color';
      if (spec.key) input.dataset.key = spec.key;
      input.value = value ?? '#000000';
      input.addEventListener('input', () => {
        onInput(input.value);
        onChange(input.value);
      });
      wrap.appendChild(input);
      return { element: wrap, get: () => input.value, set: (v) => (input.value = v) };
    });
  });
  // a dialog form
  await page.evaluate(async () => {
    const { formDialog } = await import('/lib/form.js');
    window.__formResult = formDialog(window.pigmentApp, { title: 'Fake colour', fields: [{ key: 'tint', label: 'Tint', type: 'color', value: '#336699' }] });
  });
  await expect(page.locator('.dialog .fake-color input[data-key="tint"]')).toHaveValue('#336699');
  await page.locator('.dialog .fake-color input[data-key="tint"]').evaluate((i) => {
    i.value = '#ff0000';
    i.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await confirmDialog(page);
  expect(await page.evaluate(() => window.__formResult)).toEqual({ tint: '#ff0000' });
  // the options bar (the Type tool's colour option), the gradient field's two end colours, the Character panel's two
  const r = await page.evaluate(async () => {
    const app = window.pigmentApp;
    app.tools.activate('type-horizontal');
    app.tools.renderOptions();
    const bar = document.querySelectorAll('#options-bar .fake-color').length;
    // the skeleton's gradient field (fields.js; 0.4's gradients package registers its own, which picks stop colours
    // through app.pickColor): a second instance of fields.js still holds the stub, so the fake goes there too
    const F = await import('/lib/fields.js?gradient-stub');
    F.registerWidget('color', (spec, { value }) => {
      const wrap = document.createElement('span');
      wrap.className = 'fake-color';
      const input = document.createElement('input');
      input.type = 'color';
      if (spec.key) input.dataset.key = spec.key;
      input.value = value ?? '#000000';
      wrap.appendChild(input);
      return { element: wrap, get: () => input.value, set: (v) => (input.value = v) };
    });
    const g = F.createWidget('gradient', {}, { app, value: { kind: 'linear', stops: [{ pos: 0, color: '#000000' }, { pos: 1, color: '#ffffff' }] } });
    document.body.appendChild(g.element);
    g.element.querySelector('button').click();
    const gradient = [...g.element.querySelectorAll('.fake-color input')].map((i) => i.dataset.key);
    g.destroy?.();
    const { createCharacterControls } = await import('/lib/type/char-format.js');
    const chars = createCharacterControls(app, { variant: 'panel' });
    const character = chars.element.querySelectorAll('.fake-color').length;
    chars.destroy?.();
    return { bar, gradient, character };
  });
  expect(r.bar).toBe(1);
  expect(r.gradient).toEqual(['start', 'end']);
  expect(r.character).toBe(2);
  expect(errors).toEqual([]);
});

test('colour ui: the shape popover\'s swatch row follows swatchColors; sampleMerged with until skips the layers above; the stub picker', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  const done = await landed(page);
  const rows = await page.evaluate(async () => {
    const app = window.pigmentApp;
    const { swatchColors } = await import('/lib/color-picker.js');
    const { paintPanel } = await import('/lib/shape-paint-ui.js');
    const row = () => {
      const p = paintPanel(app, { value: { type: 'solid', color: '#ff0000' } });
      const out = [...p.element.querySelectorAll('.sl-swatches .sl-color')].map((b) => b.dataset.color);
      p.destroy?.();
      return out;
    };
    const before = { row: row(), colors: swatchColors(app).slice(0, 60) };
    app.settings.swatches = ['#123456', { color: '#abcdef', name: 'Sky' }];
    app.settings.swatchesEdited = true;
    // the row shows the first 60 (with color-picker-swatches, swatchColors reads the 76 built-ins of `swatches`)
    return { before, after: { row: row(), colors: swatchColors(app).slice(0, 60) } };
  });
  expect(rows.before.row).toEqual(rows.before.colors);
  expect(rows.after.row).toEqual(rows.after.colors);
  // rule 11: 0.4's palette while the stub reads it (the package migrates it into the `swatches` kind)
  if (!done['color-picker-swatches']) expect(rows.after.colors).toEqual(['#123456', '#abcdef']);

  const sampled = await page.evaluate(async () => {
    const app = window.pigmentApp;
    const d = app.doc;
    const bottom = d.active;
    const ctx = bottom.canvas.getContext('2d');
    ctx.fillStyle = '#ff0000';
    ctx.fillRect(0, 0, bottom.canvas.width, bottom.canvas.height);
    bottom.touch();
    await app.commands.run('layer:new', undefined, 'api');
    const top = d.active;
    top.canvas.getContext('2d').fillStyle = '#0000ff';
    top.canvas.getContext('2d').fillRect(0, 0, 50, 50);
    top.touch();
    d.changed('pixels', { layer: top });
    const px = (c) => Array.from(c.getContext('2d').getImageData(10, 10, 1, 1).data);
    return { all: px(app.sampleMerged(d)), below: px(app.sampleMerged(d, { until: top })), rect: px(app.sampleMerged(d, { until: top, rect: { x: 0, y: 0, width: 20, height: 20 } })), again: px(app.sampleMerged(d)) };
  });
  expect(sampled.all).toEqual([0, 0, 255, 255]);
  expect(sampled.below).toEqual([255, 0, 0, 255]);
  expect(sampled.rect).toEqual([255, 0, 0, 255]);
  expect(sampled.again).toEqual([0, 0, 255, 255]);

  // the picker API (S7.1): pick resolves a ColorValue, the 0.4 hex API stays, tool:pick-fg sets the foreground
  const api = await page.evaluate(() => ({ real: window.pigmentApp.colorPicker.real, pick: typeof window.pigmentApp.colorPicker.pick, hud: typeof window.pigmentApp.colorPicker.hud, pickColor: typeof window.pigmentApp.pickColor }));
  expect(api).toEqual({ real: done['color-picker-swatches'], pick: 'function', hud: 'function', pickColor: 'function' });
  if (!done['color-picker-swatches']) {
    // the stub: 0.4's dialog (S7.4's DOM), the HUD session resolves null on up()
    await page.evaluate(() => {
      window.__picked = window.pigmentApp.colorPicker.pick({ initial: '#00ff00', title: 'Pick', target: 'field' });
    });
    await expect(page.locator('.color-picker-dialog')).toBeVisible();
    await page.locator('.color-picker-dialog [data-f="hex"]').fill('#204060');
    await page.locator('.color-picker-dialog [data-f="hex"]').dispatchEvent('change');
    await confirmDialog(page);
    expect(await page.evaluate(() => window.__picked)).toEqual({ hex: '#204060', rgb: [32, 64, 96], book: null, space: 'rgb' });
    expect(await page.evaluate(async () => {
      const s = window.pigmentApp.colorPicker.hud({ at: { x: 10, y: 10 }, tool: window.pigmentApp.tools.active, initial: '#ff0000' });
      s.move({ x: 20, y: 20 });
      s.up({ x: 20, y: 20 });
      return s.done;
    })).toBe(null);
    await page.evaluate(() => {
      window.pigmentApp.commands.run('tool:pick-fg', undefined, 'api');
    });
    await expect(page.locator('.color-picker-dialog')).toBeVisible();
    await page.locator('.color-picker-dialog [data-f="hex"]').fill('#112233');
    await page.locator('.color-picker-dialog [data-f="hex"]').dispatchEvent('change');
    await confirmDialog(page);
    expect(await page.evaluate(() => window.pigmentApp.settings.foreground)).toBe('#112233');
  }
  expect(errors).toEqual([]);
});

// ---- step 9: type (S11) -------------------------------------------------------------------------------------------

/** Adds a text layer from plain text (one history entry) and returns its id. */
const addTextLayer = (page, text, props = {}) =>
  page.evaluate(async ([t, p]) => {
    const app = window.pigmentApp;
    const { TextLayer } = await import('/lib/document.js');
    const { structural } = await import('/lib/layer-ops.js');
    const M = await import('/lib/type/model.js');
    const layer = new TextLayer({ content: M.fromPlain(t, { size: 60, color: '#000000' }), x: 20, y: 30, ...p });
    layer.name = t;
    structural(app, 'Add', () => {
      app.doc.add(layer);
      app.doc.setActive(layer);
    });
    return layer.id;
  }, [text, props]);

test('type: a render stage recolours a text layer and is bypassed while editing; a transformed stage gets the matrix of a vertical layer', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  const id = await addTextLayer(page, 'HHHH');
  const r = await page.evaluate(async (lid) => {
    const app = window.pigmentApp;
    const api = await import('/lib/type/api.js');
    const layer = app.doc.find(lid);
    // a stage that paints the glyphs red (source-in over what the engine drew)
    const off = api.registerTextRenderStage({
      id: 'test-red', order: 10, test: (l) => l.id === lid,
      render(l, next) {
        const base = next();
        const c = document.createElement('canvas');
        c.width = base.canvas.width;
        c.height = base.canvas.height;
        const ctx = c.getContext('2d');
        ctx.drawImage(base.canvas, 0, 0);
        ctx.globalCompositeOperation = 'source-in';
        ctx.fillStyle = '#ff0000';
        ctx.fillRect(0, 0, c.width, c.height);
        return { canvas: c, x: base.x, y: base.y };
      },
    });
    // the darkest pixel of the layer's render: red while the stage applies, black when bypassed
    const ink = () => {
      const out = layer.render();
      const d = out.canvas.getContext('2d').getImageData(0, 0, out.canvas.width, out.canvas.height).data;
      let best = null;
      for (let i = 0; i < d.length; i += 4) if (d[i + 3] === 255 && (!best || d[i] + d[i + 1] + d[i + 2] < best[0] + best[1] + best[2])) best = [d[i], d[i + 1], d[i + 2]];
      return best;
    };
    const applied = ink();
    await app.commands.run('layer:edit-text', lid, 'api');
    const editing = { ink: ink(), flag: api.isEditing(layer) };
    app.tools.active.commitSession();
    const after = { ink: ink(), flag: api.isEditing(layer) };
    off();
    const removed = ink();
    return { applied, editing, after, removed };
  }, id);
  expect(r.applied).toEqual([255, 0, 0]);
  expect(r.editing).toEqual({ ink: [0, 0, 0], flag: true });
  expect(r.after).toEqual({ ink: [255, 0, 0], flag: false });
  expect(r.removed).toEqual([0, 0, 0]);

  // a transformed stage draws in document space with the layer's matrix; TextLayer.render uses it as it is
  const vid = await addTextLayer(page, 'VV', { transform: [0, 1, -1, 0, 200, 10], typeOptions: { orientation: 'vertical' } });
  const t = await page.evaluate(async (lid) => {
    const app = window.pigmentApp;
    const api = await import('/lib/type/api.js');
    const layer = app.doc.find(lid);
    const seen = [];
    const marker = document.createElement('canvas');
    marker.width = 3;
    marker.height = 2;
    const off = api.registerTextRenderStage({ id: 'test-matrix', order: 200, transformed: true, test: (l) => l.id === lid, render: (l, next, layout, opts) => {
      seen.push(opts.matrix);
      return { canvas: marker, x: 7, y: 9 };
    } });
    const out = layer.render();
    const res = { matrix: seen.at(-1), same: out.canvas === marker, x: out.x, y: out.y, transform: layer.transform };
    off();
    return res;
  }, vid);
  expect(t.matrix).toEqual(t.transform);
  expect(t).toMatchObject({ same: true, x: 7, y: 9 });

  // a transformed stage that hands on next() (Smooth) gives the pixels of no stage: the base is still resampled
  const rid = await addTextLayer(page, 'Rot', { transform: [0, 1, -1, 0, 120, 20] });
  const p = await page.evaluate(async (lid) => {
    const app = window.pigmentApp;
    const api = await import('/lib/type/api.js');
    const layer = app.doc.find(lid);
    const snap = () => {
      layer.touch();
      const out = layer.render();
      return { x: out.x, y: out.y, w: out.canvas.width, h: out.canvas.height, data: Array.from(out.canvas.getContext('2d').getImageData(0, 0, out.canvas.width, out.canvas.height).data) };
    };
    const plain = snap();
    const off = api.registerTextRenderStage({ id: 'test-pass', order: 200, transformed: true, test: (l) => l.id === lid, render: (l, next) => next() });
    const passed = snap();
    off();
    const flagged = api.registerTextRenderStage({ id: 'test-false', order: 200, transformed: true, test: (l) => l.id === lid, render: (l, next) => ({ ...next(), transformed: false }) });
    const unflagged = snap();
    flagged();
    return { same: JSON.stringify(plain) === JSON.stringify(passed), sameFalse: JSON.stringify(plain) === JSON.stringify(unflagged), box: [plain.w, plain.h], passedBox: [passed.w, passed.h] };
  }, rid);
  expect(p.passedBox).toEqual(p.box);
  expect(p.same).toBe(true);
  expect(p.sameFalse).toBe(true);
  expect(errors).toEqual([]);
});

test('type: warp and axes survive .pigment; the model normalises them; Warp Text styles match warp.js', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  const id = await addTextLayer(page, 'Arc');
  const r = await page.evaluate(async (lid) => {
    const app = window.pigmentApp;
    const M = await import('/lib/type/model.js');
    const io = await import('/lib/io.js');
    const { WARP_PRESETS } = await import('/lib/warp.js');
    const d = app.doc;
    const layer = d.find(lid);
    layer.typeOptions = M.normalizeTypeOptions({ ...layer.typeOptions, warp: { style: 'arc', bend: 40, hDistort: -20, vDistort: 300 } });
    layer.content = M.applyChar(layer.content, 0, 3, { axes: { wght: 650, wdth: 90, bad: 1, opsz: 'x' } });
    layer.touch();
    const back = await io.readPigment(await io.writePigment(d));
    const l2 = back.layers().find((l) => l.type === 'text' && l.name === 'Arc');
    return {
      warp: l2.typeOptions.warp,
      axes: l2.content.runs[0].style.axes,
      none: 'warp' in M.normalizeTypeOptions({ warp: { style: 'none' } }),
      unknown: 'warp' in M.normalizeTypeOptions({ warp: { style: 'spiral' } }),
      plain: M.normalizeTypeOptions({}),
      styles: [...M.WARP_STYLES],
      presets: WARP_PRESETS.map(([v]) => v).filter((v) => v !== 'none' && v !== 'custom'),
      charKeys: M.CHAR_KEYS.length,
      antiAlias: [...M.ANTI_ALIAS_METHODS],
    };
  }, id);
  expect(r.warp).toEqual({ style: 'arc', horizontal: true, bend: 40, hDistort: -20, vDistort: 100 });
  expect(r.axes).toEqual({ wght: 650, wdth: 90 });
  expect(r.none).toBe(false);
  expect(r.unknown).toBe(false);
  expect(r.plain).toEqual({ orientation: 'horizontal', antiAlias: 'smooth', systemLayout: false });
  expect(r.styles).toEqual(r.presets);
  expect(r.charKeys).toBe(25);
  expect(r.antiAlias).toEqual(['none', 'sharp', 'crisp', 'strong', 'smooth', 'lcd', 'windows']);
  // the Character panel and the options bar offer the seven methods
  await page.evaluate(() => window.pigmentApp.tools.activate('type-horizontal'));
  const bar = await page.locator('#options-bar .opt[data-key="antiAlias"] select option').evaluateAll((os) => os.map((o) => o.value));
  expect(bar).toEqual(r.antiAlias);
  expect(errors).toEqual([]);
});

test('type: a fake catalog\'s PostScript-name style set from the options bar lands in the runs and in new text; new text takes the anti-alias', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  const done = await landed(page);
  // the stub catalog (rule 11: its keys are 0.4's only while type-fonts has not landed)
  if (!done['type-fonts']) {
    const stub = await page.evaluate(async () => {
      const { fontCatalog } = await import('/lib/type/api.js');
      const c = fontCatalog();
      return { real: c.real, key: c.styleKey({ fontFamily: 'Arial', fontWeight: 700, fontItalic: true }), patch: c.stylePatch('Georgia', '300'), ps: c.fromPostScriptName('Arial-BoldItalicMT'), missing: c.resolve({ fontFamily: 'No Such Family Anywhere' }).missing, arial: c.resolve({ fontFamily: 'Arial' }).missing, docMissing: c.missing(window.pigmentApp.doc) };
    });
    expect(stub).toEqual({ real: false, key: '700i', patch: { fontFamily: 'Georgia', fontWeight: 300, fontItalic: false, postScriptName: null, axes: {} }, ps: { family: 'Arial', style: { name: 'Bold Italic', postScriptName: 'Arial-BoldItalicMT', weight: 700, italic: true }, missing: false }, missing: true, arial: false, docMissing: [] });
  }
  const id = await addTextLayer(page, 'Bold me');
  const r = await page.evaluate(async (lid) => {
    const app = window.pigmentApp;
    const api = await import('/lib/type/api.js');
    const target = await import('/lib/type/target.js');
    const prev = api.fontCatalog();
    // the catalog may be a class instance (type-fonts): keep its prototype and its `this`; defined, not assigned, so a
    // frozen catalog's read-only members do not refuse the overrides
    const fake = Object.create(prev, {
      real: { value: true, enumerable: true },
      styleKey: { value: (st) => st.postScriptName ?? `${st.fontFamily}-${st.fontWeight}`, enumerable: true },
      stylePatch: { value: (family, key) => (key === 'Fake-Black' ? { fontFamily: family, fontWeight: 900, fontItalic: false, postScriptName: 'Fake-Black', axes: { wght: 900 } } : prev.stylePatch.call(prev, family, key)), enumerable: true },
    });
    api.registerFontCatalog(fake);
    try {
      const d = app.doc;
      const layer = d.find(lid);
      app.tools.activate('type-horizontal');
      const n = d.history.index;
      app.tools.setOpt('type-horizontal', 'style', 'Fake-Black');
      const entries = d.history.entries.slice(n + 1).map((e) => e.label);
      const runs = layer.content.runs.map((x) => ({ len: x.len, ps: x.style.postScriptName ?? null, axes: x.style.axes ?? null, weight: x.style.fontWeight ?? null }));
      // new text: nothing targeted, then the tool builds new text from its options
      await app.commands.run('layer:new', undefined, 'api');
      app.tools.setOpt('type-horizontal', 'antiAlias', 'crisp');
      app.tools.active.beginNew({ x: 50, y: 200 }, null);
      const s = app.tools.active.session;
      const fresh = { ps: s.layer.content.runs[0].style.postScriptName ?? null, axes: s.layer.content.runs[0].style.axes ?? null, antiAlias: s.layer.typeOptions.antiAlias };
      app.tools.active.cancelSession();
      // the defaults a tool preset captures and applies (S10.5, S12.1) read and write the catalog's key
      const pick = (c) => ({ weight: c.fontWeight, ps: c.postScriptName ?? null, axes: c.axes ?? null });
      const captured = pick(target.typeDefaults(app).char);
      app.tools.setOpt('type-horizontal', 'style', '400', { silent: true });
      target.setTypeDefaults(app, { char: { fontWeight: 900, fontItalic: false, postScriptName: 'Fake-Black', axes: { wght: 900 } } });
      const applied = { style: app.tools.opt('type-horizontal', 'style'), stored: 'postScriptName' in (app.settings.type?.char ?? {}), back: pick(target.typeDefaults(app).char) };
      return { entries, runs, fresh, captured, applied };
    } finally {
      api.registerFontCatalog(prev);
      app.tools.setOpt('type-horizontal', 'style', '400', { silent: true });
      app.tools.setOpt('type-horizontal', 'antiAlias', 'smooth', { silent: true });
    }
  }, id);
  expect(r.entries).toEqual(['Character']);
  expect(r.runs).toEqual([{ len: 7, ps: 'Fake-Black', axes: { wght: 900 }, weight: 900 }]);
  expect(r.fresh).toEqual({ ps: 'Fake-Black', axes: { wght: 900 }, antiAlias: 'crisp' });
  expect(r.captured).toEqual({ weight: 900, ps: 'Fake-Black', axes: { wght: 900 } });
  expect(r.applied).toEqual({ style: 'Fake-Black', stored: false, back: { weight: 900, ps: 'Fake-Black', axes: { wght: 900 } } });
  expect(errors).toEqual([]);
});

test('type: a TypeTool subclass in the text slot is reached by Shift+T, and a non-type command commits its session', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  await page.evaluate(async () => {
    const app = window.pigmentApp;
    const { TypeTool, registerTypeTool, typeTools } = await import('/lib/tools/text.js');
    class DummyType extends TypeTool {
      constructor(a) {
        super(a, { id: 'type-dummy', name: 'Dummy Type Tool', icon: 'text', mask: true });
      }
    }
    const t = registerTypeTool(new DummyType(app));
    app.tools.register(t, 'text');
    window.__typeTools = typeTools(app).map((x) => x.id);
    app.tools.activate('type-horizontal');
  });
  // type-menu-commands registers the two Type Mask tools as well (S11.5): the 0.4 tools first, the dummy last
  const ids = await page.evaluate(() => window.__typeTools);
  expect(ids.slice(0, 2)).toEqual(['type-horizontal', 'type-vertical']);
  expect(ids.at(-1)).toBe('type-dummy');
  await page.locator('canvas.view').hover();
  const slotSize = await page.evaluate(() => window.pigmentApp.tools.slots.find((x) => x.id === 'text')?.tools.length ?? 0);
  const seen = [];
  for (let i = 0; i < Math.max(4, slotSize + 1) && !seen.includes('type-dummy'); i++) {
    await page.keyboard.press('Shift+KeyT');
    seen.push(await page.evaluate(() => window.pigmentApp.tools.active.id));
  }
  expect(seen).toContain('type-dummy');
  const r = await page.evaluate(async () => {
    const app = window.pigmentApp;
    const { typeSession, typeTools } = await import('/lib/tools/text.js');
    const tool = app.tools.get('type-dummy');
    tool.beginNew({ x: 40, y: 120 }, null);
    tool.session.editor.insert('Dummy');
    const during = typeSession(app)?.id ?? null;
    const sibling = tool.sibling?.id ?? null;
    // the registered vertical mask tool, when type-menu-commands has landed one (S11.5)
    const verticalMask = typeTools(app).find((x) => x !== tool && !!x.mask && x.vertical !== tool.vertical)?.id ?? null;
    const layers = app.doc.layers().length;
    // a command from outside the type session commits it first (sessions.js, policy 'commit')
    await app.commands.run('layer:new', undefined, 'api');
    return { during, sibling, verticalMask, open: !!tool.session, text: app.doc.layers().find((l) => l.type === 'text')?.text ?? null, layers, after: app.doc.layers().length };
  });
  expect(r.during).toBe('type-dummy');
  expect(r.sibling).toBe(r.verticalMask); // the registered vertical mask tool, else (the skeleton) no sibling
  expect(r.open).toBe(false);
  expect(r.text).toBe('Dummy');
  expect(r.after).toBe(r.layers + 1);
  expect(errors).toEqual([]);
});

// ---- step 10: preset files (S10, S7.2) -----------------------------------------------------------------------------

test('presets: a fake two-kind format\'s file opened and dropped imports into both kinds; .ase reaches swatches; Open lists the preset files', async ({ page }) => {
  const errors = await openApp(page);
  const done = await landed(page);
  const r = await page.evaluate(async (acoAseReal) => {
    const app = window.pigmentApp;
    const F = await import('/lib/preset-formats.js');
    const { registerPresetFormat, presetFormats } = await import('/lib/presets.js');
    // a tiny PNG (2 × 2, opaque): the pattern's side file
    const c = document.createElement('canvas');
    c.width = c.height = 2;
    c.getContext('2d').fillRect(0, 0, 2, 2);
    const png = new Uint8Array(await (await new Promise((res) => c.toBlob(res, 'image/png'))).arrayBuffer());
    // a format of two kinds: a brush whose texture names the file's own pattern through a file-local ref
    const off = F.registerPresetFileFormat({
      id: 'skeleton-fake', name: 'Fake brushes', extensions: ['fakebrushes'], kinds: ['brushes', 'patterns'],
      async read() {
        return {
          items: [
            { kind: 'brushes', name: 'Fake textured', data: { tip: { size: 33 }, texture: { enabled: true, pattern: { $presetRef: { kind: 'patterns', ref: 'pat' } } } } },
            { kind: 'patterns', ref: 'pat', name: 'Fake pattern', data: { width: 2, height: 2, blob: 'fake-pattern.png', mode: 'rgb' }, blobs: { 'fake-pattern.png': png } },
          ],
          report: [],
        };
      },
    });
    const count = (kind, name) => app.presets.list(kind).filter((p) => p.name === name).length;
    const docs0 = app.docs.list().length;
    try {
      await Promise.all(['brushes', 'patterns', 'swatches'].map((k) => app.presets.ready(k)));
      window.__pigmentTest.files['mem:/set.fakebrushes'] = new Uint8Array([1]);
      await app.commands.run('file:open-paths', ['mem:/set.fakebrushes'], 'api');
      const brush = app.presets.list('brushes').find((p) => p.name === 'Fake textured');
      const pattern = app.presets.list('patterns').find((p) => p.name === 'Fake pattern');
      const opened = { brushes: count('brushes', 'Fake textured'), patterns: count('patterns', 'Fake pattern'), ref: brush?.data.texture.pattern, patternId: pattern?.id, blob: !!(await app.presets.readBlob('patterns', 'fake-pattern.png')) };
      // dropped on the window: imported again, not opened
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array([1])], 'dropped.fakebrushes'));
      window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
      const t0 = Date.now();
      while (count('brushes', 'Fake textured') < 2 && Date.now() - t0 < 4000) await new Promise((res) => setTimeout(res, 50));
      const dropped = { brushes: count('brushes', 'Fake textured'), patterns: count('patterns', 'Fake pattern') };
      // .ase goes to `swatches` only (S7.2): preset-files-manager's format, or a stand-in until it lands
      if (!acoAseReal && !presetFormats('swatches').some((f) => (f.extensions ?? []).includes('ase'))) {
        registerPresetFormat('swatches', { id: 'skeleton-ase', name: 'Swatch Exchange', extensions: ['ase'], read: async () => ({ presets: [{ name: 'From ASE', data: { color: { space: 'rgb', values: [255, 0, 0] } } }], report: [] }) });
      }
      // an Adobe Swatch Exchange file with one RGB colour "From ASE"
      const name = 'From ASE';
      const blockLen = 2 + (name.length + 1) * 2 + 4 + 12 + 2;
      const ase = new Uint8Array(12 + 6 + blockLen);
      const dv = new DataView(ase.buffer);
      ase.set([65, 83, 69, 70]);
      dv.setUint16(4, 1);
      dv.setUint32(8, 1);
      dv.setUint16(12, 1);
      dv.setUint32(14, blockLen);
      dv.setUint16(18, name.length + 1);
      for (let i = 0; i < name.length; i++) dv.setUint16(20 + i * 2, name.charCodeAt(i));
      let o = 20 + (name.length + 1) * 2;
      ase.set([82, 71, 66, 32], o);
      dv.setFloat32(o + 4, 1);
      dv.setFloat32(o + 8, 0);
      dv.setFloat32(o + 12, 0);
      dv.setUint16(o + 16, 2);
      window.__pigmentTest.files['mem:/colours.ase'] = ase;
      const before = { gradients: app.presets.list('gradients').length, patterns: app.presets.list('patterns').length };
      await app.commands.run('file:open-paths', ['mem:/colours.ase'], 'api');
      const swatch = app.presets.list('swatches').find((p) => p.name === 'From ASE');
      const ased = { swatch: swatch?.data.color ?? null, gradients: app.presets.list('gradients').length - before.gradients, patterns: app.presets.list('patterns').length - before.patterns };
      // File > Open: a "Presets" filter lists the registered preset file extensions
      let filters = null;
      const orig = app.bridge.openFileDialog;
      app.bridge.openFileDialog = async (opts) => {
        filters = opts.filters;
        return [];
      };
      try {
        await app.docs.openDialog();
      } finally {
        app.bridge.openFileDialog = orig;
      }
      return { opened, dropped, ased, docs: app.docs.list().length - docs0, presetsFilter: filters?.find((f) => f.name === 'Presets')?.extensions ?? null, last: filters?.at(-1)?.name };
    } finally {
      off();
    }
  }, done.acoAseReal);
  expect(r.opened).toMatchObject({ brushes: 1, patterns: 1, blob: true });
  expect(r.opened.ref).toEqual({ presetId: r.opened.patternId, name: 'Fake pattern' });
  expect(r.dropped).toEqual({ brushes: 2, patterns: 2 });
  expect(r.ased.swatch?.space).toBe('rgb');
  expect(r.ased.swatch.values.map(Math.round)).toEqual([255, 0, 0]);
  expect([r.ased.gradients, r.ased.patterns]).toEqual([0, 0]);
  expect(r.docs).toBe(0); // nothing was opened as a document
  expect(r.presetsFilter).toEqual(expect.arrayContaining(['fakebrushes', 'pigment-presets', 'ase']));
  expect(r.last).toBe('All files');
  expect(errors).toEqual([]);
});

test('presets: with a writable gradients format registered, the Gradients panel\'s Export still writes .pigment-presets', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page);
  await page.evaluate(async () => {
    const app = window.pigmentApp;
    const { registerPresetFormat } = await import('/lib/presets.js');
    // registered for the kind as preset-files-manager's .grd will be (S10.1): 0.4's Export would have picked it, being
    // first (its own extension, so a .grd that has landed does not take the typed name below)
    registerPresetFormat('gradients', { id: 'skeleton-grd', name: 'Test Gradients', extensions: ['skgrd'], read: async () => ({ presets: [], report: [] }), write: async () => new Uint8Array([8, 66, 73, 77]) });
    window.__seenSave = null;
    const orig = app.bridge.saveFileDialog;
    app.bridge.saveFileDialog = (opts) => {
      window.__seenSave = opts;
      return orig(opts);
    };
    window.__pigmentTest.nextSavePath = 'mem:/MyGradients';
    app.panels.show('gradients', { reveal: true });
  });
  const panel = page.locator('.panel[data-panel="gradients"]');
  await panel.locator('[data-act="menu"]').click();
  await page.locator('.popover-item', { hasText: 'Export All Gradients' }).click();
  await expect.poll(() => page.evaluate(() => !!window.__pigmentTest.written['mem:/MyGradients.pigment-presets'])).toBe(true);
  const r = await page.evaluate(async () => {
    const file = JSON.parse(new TextDecoder().decode(window.__pigmentTest.written['mem:/MyGradients.pigment-presets']));
    // the typed extension picks the format: .skgrd writes the registered format
    const { exportPresets } = await import('/lib/gradient-editor.js');
    await exportPresets(window.pigmentApp, null, 'mem:/Typed.skgrd');
    return { format: file.format, kind: file.kind, n: file.items.length, defaultPath: window.__seenSave?.defaultPath, filters: window.__seenSave?.filters.map((f) => f.extensions[0]), grd: Array.from(window.__pigmentTest.written['mem:/Typed.skgrd'] ?? []) };
  });
  expect(r).toMatchObject({ format: 'pigment-presets', kind: 'gradients', defaultPath: 'Gradients.pigment-presets', grd: [8, 66, 73, 77] });
  expect(r.n).toBeGreaterThan(0);
  expect(r.filters[0]).toBe('pigment-presets');
  expect(r.filters).toContain('skgrd');
  expect(errors).toEqual([]);
});

test('presets: a custom shape whose preset is deleted keeps its outline through edits, .pigment and PSD', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 160, height: 120, background: 'transparent' });
  const r = await page.evaluate(async () => {
    const app = window.pigmentApp;
    const io = await import('/lib/io.js');
    const { createShapeLayer } = await import('/lib/tools/vector.js');
    const { livePath, regenerateShape } = await import('/lib/path-ops.js');
    const { readPsd } = await import('ag-psd');
    await app.presets.ready('shapes');
    // a diamond: nothing like the heart a missing preset falls back to
    const diamond = { subpaths: [{ closed: true, points: [[0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5]].map(([x, y]) => ({ x, y })) }] };
    const preset = app.presets.add('shapes', { name: 'Diamond', data: { path: diamond } });
    const props = { x: 20, y: 20, width: 80, height: 80, angle: 0, shape: preset.id };
    const layer = createShapeLayer(app, livePath('custom', props), { name: 'Diamond', label: 'Custom Shape', style: { fill: { type: 'solid', color: '#ff0000' }, stroke: null }, kind: 'custom', props });
    const corners = () => layer.path.subpaths.map((sp) => sp.points.map((p) => [Math.round(p.x), Math.round(p.y)]));
    // an edit while the preset exists fills shapeProps.unit
    await app.commands.run('layer:shape-properties', { props: { width: 100 } }, 'api');
    const unit = JSON.parse(JSON.stringify(layer.shapeProps.unit ?? null));
    app.presets.remove('shapes', [preset.id]);
    await app.commands.run('layer:shape-properties', { props: { width: 120 } }, 'api');
    const afterDelete = corners();
    // .pigment: the outline comes back with the layer, and a regenerate still draws it
    const back = await io.readPigment(await io.writePigment(app.doc));
    const bl = back.layers().find((l) => l.type === 'shape');
    const regen = regenerateShape(bl, { height: 40 }).path.subpaths.map((sp) => sp.points.map((p) => [Math.round(p.x), Math.round(p.y)]));
    // PSD: the layer's pixels are the diamond's (the left tip is filled, the box corner is not)
    const psd = readPsd(io.writePsdDocument(app.doc, app.doc.view.compositor), { skipThumbnail: true, skipCompositeImageData: true });
    const rec = psd.children.find((c) => c.name === layer.name);
    const alphaAt = (x, y) => rec.canvas.getContext('2d').getImageData(x - rec.left, y - rec.top, 1, 1).data[3];
    return { unit, afterDelete, backUnit: !!bl.shapeProps.unit, regen, tip: alphaAt(24, 60), corner: alphaAt(30, 26), centre: alphaAt(80, 60) };
  });
  expect(r.unit?.subpaths?.[0]?.points?.length).toBe(4);
  expect(r.afterDelete).toEqual([[[80, 20], [140, 60], [80, 100], [20, 60]]]);
  expect(r.backUnit).toBe(true);
  expect(r.regen).toEqual([[[80, 20], [140, 40], [80, 60], [20, 40]]]);
  expect(r.tip).toBeGreaterThan(200);
  expect(r.corner).toBe(0);
  expect(r.centre).toBe(255);
  expect(errors).toEqual([]);
});

// ---- step 11: toolbox and transform (S12.1, S12.2) ------------------------------------------------------------------

test('toolbox: options-bar slots render; resetOptions; setOptions on a Type tool with a text layer active edits no layer', async ({ page }) => {
  const errors = await openApp(page);
  const done = await landed(page);
  await newDoc(page);
  const r = await page.evaluate(async () => {
    const app = window.pigmentApp;
    const t = app.tools;
    t.activate('brush');
    const el = (cls, text) => Object.assign(document.createElement('span'), { className: cls, textContent: text });
    const offTitle = t.registerOptionsSlot({ id: 'test-title', place: 'title', order: -1e6, render: (tool) => el('test-title', `Preset of ${tool.id}`) });
    const offStart = t.registerOptionsSlot({ id: 'test-start', place: 'start', order: -1e6, render: () => el('test-start', 'S') });
    const offEnd = t.registerOptionsSlot({ id: 'test-end', place: 'end', order: 1e6, render: (tool) => (tool.id === 'brush' ? el('test-end', 'E') : null) });
    const bar = document.getElementById('options-bar');
    const order = () => [...bar.children].map((c) => c.className.split(' ')[0]);
    const withSlots = order();
    const titleText = bar.querySelector('.test-title')?.textContent;
    t.activate('move');
    const moveHasEnd = !!bar.querySelector('.test-end');
    t.activate('brush');
    offTitle();
    offStart();
    offEnd();
    const without = order();

    // resetOptions: the stored options go, the bar shows the defaults, 'tool:options' says '*'
    const events = [];
    app.on('tool:options', (e) => events.push({ tool: e.tool, key: e.key, batch: !!e.batch }));
    t.setOpt('brush', 'opacity', 0.25);
    events.length = 0;
    t.resetOptions('brush');
    const reset = { stored: app.settings.tools?.brush ?? null, opacity: t.opt('brush', 'opacity'), events: events.splice(0) };

    window.__toolboxEvents = events;
    return { withSlots, titleText, moveHasEnd, without, reset };
  });
  // setOptions on the Type tool with a text layer active: the tool's options change, the layer does not
  await addTextLayer(page, 'Hello', { x: 40, y: 80 });
  r.type = await page.evaluate(() => {
    const app = window.pigmentApp;
    const t = app.tools;
    const events = window.__toolboxEvents;
    const layer = app.doc.active;
    // the real Type tool ('text' is its slot), activated first as presets-panels does (S12.1)
    t.activate('type-horizontal');
    const active = t.active?.id;
    const h0 = app.doc.history.index;
    const before = JSON.stringify(layer.content) + JSON.stringify(layer.typeOptions ?? null);
    events.length = 0;
    t.setOptions('type-horizontal', { size: 72, family: 'Georgia' });
    const after = JSON.stringify(layer.content) + JSON.stringify(layer.typeOptions ?? null);
    return { active, isText: layer.type === 'text', same: before === after, entries: app.doc.history.index - h0, size: t.opt('type-horizontal', 'size'), family: t.opt('type-horizontal', 'family'), events: events.splice(0) };
  });
  expect(r.withSlots.slice(0, 2)).toEqual(['test-title', 'test-start']);
  expect(r.withSlots.at(-1)).toBe('test-end');
  expect(r.withSlots).not.toContain('options-title');
  expect(r.titleText).toBe('Preset of brush');
  expect(r.moveHasEnd).toBe(false);
  if (!done['presets-panels']) expect(r.without[0]).toBe('options-title'); // its tool preset picker is a title slot
  expect(r.without).not.toContain('test-start');
  expect(r.reset.stored).toBeNull();
  expect(r.reset.opacity).toBe(1);
  expect(r.reset.events).toEqual([{ tool: 'brush', key: '*', batch: false }]);
  expect(r.type.active).toBe('type-horizontal');
  expect(r.type.size).toBe(72);
  expect(r.type.family).toBe('Georgia');
  expect(r.type.entries).toBe(0);
  expect(r.type.isText).toBe(true);
  expect(r.type.same).toBe(true);
  expect(r.type.events.filter((e) => e.batch).map((e) => e.key).sort()).toEqual(['family', 'size']);
  expect(r.type.events.at(-1)).toEqual({ tool: 'type-horizontal', key: '*', batch: false });
  expect(errors).toEqual([]);
});

/** Adds raster layers filled black at the given rects; the last one is active. */
const addBoxes = (page, rects) =>
  page.evaluate(async (list) => {
    const app = window.pigmentApp;
    const { RasterLayer, createCanvas } = await import('/lib/document.js');
    const { structural } = await import('/lib/layer-ops.js');
    const out = [];
    for (const [i, r] of list.entries()) {
      const c = createCanvas(r.width, r.height);
      c.getContext('2d').fillRect(0, 0, r.width, r.height);
      const layer = new RasterLayer({ name: `Box ${i + 1}`, canvas: c, x: r.x, y: r.y });
      structural(app, 'Add', () => {
        app.doc.add(layer);
        app.doc.setActive(layer);
      });
      out.push(layer.id);
    }
    return out;
  }, rects);

test('toolbox: previewBox equals the box Free Transform takes, for a raster layer with a pixel selection and for two layers', async ({ page }) => {
  const errors = await openApp(page);
  await newDoc(page, { width: 200, height: 150, background: 'transparent' });
  const ids = await addBoxes(page, [{ x: 40, y: 40, width: 40, height: 30 }, { x: 120, y: 90, width: 20, height: 20 }]);
  const r = await page.evaluate(async (ids) => {
    const app = window.pigmentApp;
    const tt = app.transformTool;
    const d = app.doc;
    const { Selection } = await import('/lib/selection.js');
    const compare = () => {
      const pb = tt.previewBox(d);
      app.commands.run('edit:free-transform', undefined, 'api');
      const s = tt.session;
      const out = { preview: pb && { box: pb.box, targets: pb.targets.map((l) => l.id), selectionOnly: pb.selectionOnly }, session: s && { box: { ...s.box }, targets: s.targets.map((l) => l.id), selectionOnly: s.selectionOnly }, during: tt.previewBox(d) };
      tt.cancel();
      return out;
    };
    // one raster layer and a pixel selection: the selected pixels
    d.setActive(d.find(ids[0]));
    d.selection = Selection.fromRect(d.width, d.height, { x: 50, y: 30, width: 20, height: 20 });
    d.changed('selection');
    const sel = compare();
    // two layers, no selection: the union of their contents
    d.selection = null;
    d.changed('selection');
    d.setActive(d.find(ids[1]));
    d.setActive(d.find(ids[0]), { additive: true });
    const two = compare();
    return { sel, two, none: (() => {
      // nothing to transform: null, as start() would refuse
      app.newDocument({ width: 20, height: 20, name: 'Empty', background: 'transparent' });
      return tt.previewBox(app.doc);
    })() };
  }, ids);
  expect(r.sel.preview).toEqual({ box: { x: 50, y: 40, width: 20, height: 10 }, targets: [ids[0]], selectionOnly: false });
  expect(r.sel.session).toEqual(r.sel.preview);
  expect(r.sel.during).toBeNull();
  expect(r.two.preview.box).toEqual({ x: 40, y: 40, width: 100, height: 70 });
  expect(r.two.session).toEqual(r.two.preview);
  expect(r.none).toBeNull();
  expect(errors).toEqual([]);
});

test('toolbox: a grab on \'se\' continues the drag into one Free Transform entry, also from the Ctrl-held Move tool, without distorting', async ({ page }) => {
  const errors = await openApp(page);
  const done = await landed(page);
  await newDoc(page, { width: 200, height: 150, background: 'transparent' });
  const [id] = await addBoxes(page, [{ x: 40, y: 40, width: 40, height: 30 }]);
  // the Move tool's handles are move-tool-depth's; until it lands a press near the box's 'se' corner grabs it here
  await page.evaluate((real) => {
    const app = window.pigmentApp;
    if (real) {
      app.tools.setOpt('move', 'showTransform', true);
      return;
    }
    const move = app.tools.get('move');
    window.__realMoveDown ??= move.onPointerDown;
    move.onPointerDown = function (p) {
      const pb = app.transformTool.previewBox(app.doc);
      const se = pb && [pb.box.x + pb.box.width, pb.box.y + pb.box.height];
      if (se && Math.hypot(p.x - se[0], p.y - se[1]) < 4) return app.transformTool.start({ mode: 'free', grab: { pointer: p, handle: 'se' } });
      return window.__realMoveDown.call(this, p);
    };
  }, done['move-tool-depth']);
  const quadAfter = async (prepare, modifiers) => {
    await page.evaluate(prepare);
    const h0 = await page.evaluate(() => window.pigmentApp.doc.history.index);
    const a = await screenPoint(page, 80, 70);
    const b = await screenPoint(page, 100, 90);
    for (const m of modifiers) await page.keyboard.down(m);
    await page.mouse.move(a.x, a.y);
    if (modifiers.includes('Control')) await expect.poll(() => page.evaluate(() => window.pigmentApp.view.tempTool?.id ?? null)).toBe('move');
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 6 });
    await page.mouse.up();
    for (const m of modifiers) await page.keyboard.up(m);
    return page.evaluate((h) => {
      const app = window.pigmentApp;
      const tt = app.transformTool;
      const quad = tt.session?.quad.map((q) => q.map((v) => Math.round(v))) ?? null;
      tt.commit();
      const d = app.doc;
      return { quad, tool: app.tools.active.id, labels: d.history.entries.slice(h + 1, d.history.index + 1).map((e) => e.label), x: d.active.x, y: d.active.y, w: d.active.canvas.width, h: d.active.canvas.height };
    }, h0);
  };
  // the Move tool active: the drag scales the box from its 'se' corner
  const plain = await quadAfter(() => window.pigmentApp.tools.activate('move'), []);
  expect(plain.quad).toEqual([[40, 40], [100, 40], [100, 90], [40, 90]]);
  expect(plain.labels).toEqual(['Free transform']); // 0.4's label
  expect(plain.tool).toBe('move');
  // undo, then from the Brush with Ctrl held (the temporary Move tool): the same scale, no distortion by the held Ctrl
  await page.evaluate(() => window.pigmentApp.commands.run('edit:undo', undefined, 'api'));
  const ctrl = await quadAfter(() => window.pigmentApp.tools.activate('brush'), ['Control']);
  expect(ctrl.quad).toEqual([[40, 40], [100, 40], [100, 90], [40, 90]]);
  expect(ctrl.labels).toEqual(['Free transform']);
  expect(ctrl.tool).toBe('brush'); // back to the tool that was active
  expect(await page.evaluate((lid) => window.pigmentApp.doc.find(lid) === window.pigmentApp.doc.active, id)).toBe(true);
  expect(errors).toEqual([]);
});

// ---- step 12: the whole skeleton --------------------------------------------------------------------------------------

test('start-up: a headless start shows no console error or warning, with every 0.5 stub and service in place', async ({ page }) => {
  const messages = [];
  page.on('console', (m) => {
    if (m.type() === 'warning' || m.type() === 'error') messages.push(`${m.type()}: ${m.text()}`);
  });
  const errors = await openApp(page);
  await newDoc(page);
  // the services start() creates before MODULES (New files): every one is there
  const services = await page.evaluate(() => {
    const app = window.pigmentApp;
    return { keymap: typeof app.keymap?.keysFor, presets: typeof app.presets?.list, colorPicker: typeof app.colorPicker?.pick, transform: typeof app.transformTool?.previewBox, slots: typeof app.tools.registerOptionsSlot };
  });
  expect(services).toEqual({ keymap: 'function', presets: 'function', colorPicker: 'function', transform: 'function', slots: 'function' });
  await page.waitForTimeout(500); // late warnings (deferred loads) too
  expect(messages).toEqual([]);
  expect(errors).toEqual([]);
});
