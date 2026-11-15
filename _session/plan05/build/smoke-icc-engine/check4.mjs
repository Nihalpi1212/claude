export default async function (page) {
  const r = await page.evaluate(async () => {
    const app = window.pigmentApp;
    const P = await import('/lib/color/pipeline.js');
    await P.colorEngine().ready();
    app.newDocument({ width: 2000, height: 1500, name: 'T' });
    const v = app.doc.view; const comp = v.composite();
    const n = 200000; const t0 = performance.now();
    for (let i = 0; i < n; i++) P.toDisplay(comp, v);
    return { usPerCall: ((performance.now() - t0) * 1000 / n).toFixed(3), same: P.toDisplay(comp, v) === comp };
  });
  console.log(JSON.stringify(r));
}
