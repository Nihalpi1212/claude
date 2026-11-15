export default async function (page) {
  const r = await page.evaluate(async () => ({
    engine: (await import('/lib/brush.js')).ENGINE?.id,
    abr: (await import('/lib/brush/abr.js')).ABR_REAL,
    gesture: (await import('/lib/tools/paint-gesture.js')).PaintGesture?.real,
    color: (await import('/lib/color/pipeline.js')).colorEngine()?.available,
    psd: (await import('/lib/psd/registry.js')).psdFeatures(),
    dev: (await import('/lib/develop/registry.js')).developFeatures(),
    aco: (await import('/lib/preset-files/aco-ase.js')).ACO_ASE_REAL,
    picker: window.pigmentApp.colorPicker.real,
    fonts: (await import('/lib/type/api.js')).fontCatalog().real,
    move: (await import('/lib/tools/move-handles.js')).MOVE_FEATURES,
  }));
  console.log(JSON.stringify(r));
}
