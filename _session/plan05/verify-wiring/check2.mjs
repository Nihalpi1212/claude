export default async function (page, logs) {
  const r = await page.evaluate(async () => {
    const app = window.pigmentApp;
    const want = {
      '/lib/brush/tool-brush.js': ['setToolBrush', 'toolBrush', 'prepareBrush', 'installToolBrush'],
      '/lib/brush.js': ['registerDabModifier', 'strokeReach', 'tipOutline', 'renderStrokePreview', 'ENGINE', 'BrushStroke', 'traceDabs'],
      '/lib/tools/paint-gesture.js': ['PaintGesture'],
      '/lib/tools/paint-keys.js': ['install'],
      '/lib/brush/abr.js': ['brushFromAgPsd', 'ABR_REAL'],
      '/lib/preset-files/aco-ase.js': ['parseAse', 'parseAco', 'ACO_ASE_REAL'],
      '/lib/psd/effects.js': ['stylesFromPsd', 'stylesToPsd'],
      '/lib/psd/vector.js': ['pathFromPsd', 'pathToPsd'],
      '/lib/psd/registry.js': ['psdFeatures'],
      '/lib/color/pipeline.js': ['colorEngine', 'registerColorEngine'],
      '/lib/color-picker.js': ['swatchColors'],
      '/lib/develop/registry.js': ['developFeatures', 'setDevelopFeature', 'createFakeWorkspace'],
      '/lib/type/api.js': ['fontCatalog', 'setEditing'],
      '/lib/tools/text.js': ['TypeTool', 'registerTypeTool', 'typeTools'],
      '/lib/documents.js': ['registerOpenHook', 'registerSaveOptions'],
      '/lib/preset-formats.js': ['registerPresetFileFormat', 'presetFileFormats', 'importPresetFiles', 'exportPresetsDialog', 'registerBlobRefs', 'blobRefs'],
      '/lib/tools/move-handles.js': ['MOVE_FEATURES'],
      '/lib/brush/options.js': ['BRUSH_OPTIONS', 'BRUSH_SIZE'],
      '/lib/shortcuts-editor.js': ['install'],
    };
    const out = {};
    for (const [m, names] of Object.entries(want)) {
      try { const mod = await import(m); out[m] = names.filter((n) => !(n in mod)); } catch (e) { out[m] = 'IMPORT FAIL ' + e.message; }
    }
    out.app = { colorPickerHud: typeof app.colorPicker?.hud, real: app.colorPicker?.real, rememberCommand: typeof app.filterEditor?.rememberCommand, smartKind: typeof app.smartFilters?.registerKind, previewBox: typeof app.transformTool?.previewBox, tempClear: typeof app.tempTools?.clear, keymapResolve: typeof app.keymap?.resolveKey, brushPicker: typeof app.brushPicker?.renderButton, typeTools: typeof app.typeTools };
    const cat = (await import('/lib/type/api.js')).fontCatalog();
    out.catalog = Object.keys(cat).filter((k) => typeof cat[k] === 'function');
    out.catalogReal = cat.real;
    return out;
  });
  console.log(JSON.stringify(r, null, 1));
}
