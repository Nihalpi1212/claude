export default async function (page, logs) {
  const out = await page.evaluate(async () => {
    const app = window.pigmentApp;
    const res = {};
    app.newDocument({ width: 200, height: 150, name: 'A' });
    const { TextLayer } = await import('/lib/document.js');
    const { structural } = await import('/lib/layer-ops.js');
    const M = await import('/lib/type/model.js');
    const layer = new TextLayer({ content: M.fromPlain('Hello', { size: 30, color: '#000000' }), x: 20, y: 60 });
    structural(app, 'Add', () => { app.doc.add(layer); app.doc.setActive(layer); });
    // 1. setOptions on the real type tool id with a text layer active, tool active first (S12.1)
    const t = app.tools;
    t.activate('type-horizontal');
    const h0 = app.doc.history.index;
    const before = JSON.stringify(layer.content);
    t.setOptions('type-horizontal', { size: 72, family: 'Georgia' });
    res.afterSet = { size: t.opt('type-horizontal', 'size'), family: t.opt('type-horizontal', 'family'), same: JSON.stringify(layer.content) === before, entries: app.doc.history.index - h0 };
    // a later re-selection of the same layer (Layers panel click)
    app.doc.setActive(layer);
    app.doc.changed('layers');
    await new Promise((r) => setTimeout(r, 50));
    res.afterReselect = { size: t.opt('type-horizontal', 'size'), family: t.opt('type-horizontal', 'family') };
    t.renderOptions();
    res.afterRender = { size: t.opt('type-horizontal', 'size'), family: t.opt('type-horizontal', 'family') };
    // 2. a transformed stage that calls next() (Smooth) on a rotated text layer
    const api = await import('/lib/type/api.js');
    layer.transform = [0, 1, -1, 0, 120, 20];
    layer.touch();
    const plain = layer.render();
    const p = { w: plain.canvas.width, h: plain.canvas.height };
    const off = api.registerTextRenderStage({ id: 'aa-smooth', order: 200, transformed: true, test: () => true, render: (l, next) => next() });
    const staged = layer.render();
    res.transformedSmooth = { plain: p, staged: { w: staged.canvas.width, h: staged.canvas.height } };
    off();
    // 3. keymap
    const k = app.keymap;
    res.keys = {};
    res.keys.revert = k.keysFor('file:revert');
    let c = k.set('file:revert', ['CmdOrCtrl+Alt+Shift+K']);
    res.keys.conflict = c;
    res.keys.revertAfterConflict = k.keysFor('file:revert');
    c = k.set('file:revert', ['CmdOrCtrl+Alt+Shift+K'], { force: true });
    res.keys.forced = { revert: k.keysFor('file:revert'), shortcuts: k.keysFor('help:shortcuts'), menuOverlay: k.overlay().menu };
    k.set('file:revert', ['Q']);
    res.keys.plain = { menu: k.keysFor('file:revert', 'menu'), renderer: k.keysFor('file:revert', 'renderer') };
    res.keys.fixed = k.set('file:revert', ['Shift+CmdOrCtrl+F12'], { force: true });
    k.reset();
    res.keys.resetRevert = k.keysFor('file:revert');
    res.keys.paintSet = k.set('tool:opacity-digit-1', ['9'], { scope: 'paint' });
    k.reset();
    // 4. colour picker
    res.picker = { real: app.colorPicker.real, keys: Object.keys(app.colorPicker) };
    const s = app.colorPicker.hud({ at: { x: 1, y: 1 }, tool: t.active, initial: '#ff0000' });
    s.cancel();
    res.hudCancel = await s.done;
    const cp = await import('/lib/color-picker.js');
    res.swatches = cp.swatchColors(app).length;
    // 5. preset formats
    const F = await import('/lib/preset-formats.js');
    res.formats = F.presetFileFormats().map((f) => `${f.id}:${f.kinds.join('+')}:${f.store}`);
    res.forPigmentPresets = F.presetFileFormatFor('a.pigment-presets')?.id ?? null;
    res.abr = F.presetFileFormatFor('a.abr')?.id ?? null;
    res.bundle = F.BUNDLE_SETTINGS;
    res.blobRefTool = F.blobRefs('tool-presets', { tool: 'brush', options: {}, brush: { tip: { kind: 'sampled', sample: { blob: 'tip-a.png' } } } });
    res.kinds = ['brushes', 'swatches', 'color-books', 'color-profiles', 'camera-raw-presets', 'camera-raw-snapshots', 'camera-raw-profiles', 'fonts', 'keyboard-shortcuts', 'menu-sets', 'styles', 'shapes', 'tool-presets'].map((kk) => [kk, !!(app.presets.list && (() => { try { app.presets.state(kk); return true; } catch { return false; } })())]);
    await app.presets.ready('keyboard-shortcuts');
    res.sets = k.sets().map((x) => x.id);
    // 6. type tools
    const text = await import('/lib/tools/text.js');
    res.typeTools = text.typeTools(app).map((x) => x.id);
    res.fontCatalogReal = api.fontCatalog().real;
    // 7. previewBox
    res.preview = app.transformTool.previewBox(app.doc);
    res.preview = res.preview && { box: res.preview.box, n: res.preview.targets.length };
    // 8. lastFilter
    res.filterEditor = Object.keys(app.filterEditor);
    // 9. move handles
    res.move = (await import('/lib/tools/move-handles.js')).MOVE_FEATURES;
    return res;
  });
  console.log(JSON.stringify(out, null, 1));
}
