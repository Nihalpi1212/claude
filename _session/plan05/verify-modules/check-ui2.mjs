export default async function (page, logs) {
  const out = await page.evaluate(async () => {
    const app = window.pigmentApp;
    const r = {};
    const b = await import('/lib/brush.js'); r.engine = b.ENGINE?.id;
    const g = await import('/lib/tools/paint-gesture.js'); r.gesture = g.PaintGesture?.real;
    const p = await import('/lib/color/pipeline.js'); r.cmm = p.colorEngine?.().available;
    const psd = await import('/lib/psd/registry.js'); r.psd = psd.psdFeatures?.();
    const d = await import('/lib/develop/registry.js'); r.dev = d.developFeatures?.(); r.setDev = typeof d.setDevelopFeature;
    const a = await import('/lib/brush/abr.js'); r.abr = a.ABR_REAL;
    const ac = await import('/lib/preset-files/aco-ase.js'); r.aco = ac.ACO_ASE_REAL;
    const t = await import('/lib/type/api.js'); r.font = t.fontCatalog().real;
    const m = await import('/lib/tools/move-handles.js'); r.move = m.MOVE_FEATURES;
    r.cp = app.colorPicker.real;
    // shortcuts list with an overlay
    app.keymap.set('file:revert', ['CmdOrCtrl+Alt+Shift+F11']);
    r.searchKey = (await import('/lib/command-search.js'));
    r.searchKey = Object.keys(r.searchKey);
    app.keymap.reset();
    // swatches when migrated
    app.settings.colorUI = { ...(app.settings.colorUI ?? {}), swatchesMigrated: true };
    await app.presets.ready('swatches');
    const cp = await import('/lib/color-picker.js');
    r.migratedList = cp.swatchColors(app).slice(0, 3);
    app.settings.colorUI.swatchesMigrated = false;
    // the font-family widget path in the options bar
    app.newDocument({ width: 50, height: 50 });
    app.tools.activate('type-horizontal');
    r.familyDom = !!document.querySelector('#options-bar .opt[data-key="family"] select');
    r.styleDom = !!document.querySelector('#options-bar .opt[data-key="style"] select');
    r.colorDom = !!document.querySelector('#options-bar input[type="color"]');
    return r;
  });
  console.log(JSON.stringify(out, null, 1));
}
