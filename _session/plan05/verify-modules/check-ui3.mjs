export default async function (page, logs) {
  const out = await page.evaluate(async () => {
    const app = window.pigmentApp;
    const r = {};
    app.newDocument({ width: 50, height: 50 });
    await app.presets.ready('swatches');
    app.settings.colorUI = { ...(app.settings.colorUI ?? {}), swatchesMigrated: true };
    const { swatchColors } = await import('/lib/color-picker.js');
    const { paintPanel } = await import('/lib/shape-paint-ui.js');
    const p = paintPanel(app, { value: { type: 'solid', color: '#ff0000' } });
    r.row = p.element.querySelectorAll('.sl-swatches .sl-color').length;
    r.colors = swatchColors(app).length;
    app.settings.colorUI.swatchesMigrated = false;
    // typeDefaults with a real-catalog style key (a PostScript name)
    const api = await import('/lib/type/api.js');
    const T = await import('/lib/type/target.js');
    const prev = api.fontCatalog();
    api.registerFontCatalog({ ...prev, real: true, styleKey: (s) => s.postScriptName ?? 'X-Regular', stylePatch: (f, k) => ({ fontFamily: f, fontWeight: k === 'Fake-Black' ? 900 : 400, fontItalic: false, postScriptName: k, axes: {} }) });
    app.tools.setOpt('type-horizontal', 'style', 'Fake-Black', { silent: true });
    const d = T.typeDefaults(app).char;
    r.typeDefaults = { weight: d.fontWeight, ps: d.postScriptName ?? null };
    T.setTypeDefaults(app, { char: { fontWeight: 900, fontItalic: false, postScriptName: 'Fake-Black' } });
    r.styleAfterSet = app.tools.opt('type-horizontal', 'style');
    api.registerFontCatalog(prev);
    return r;
  });
  console.log(JSON.stringify(out));
}
