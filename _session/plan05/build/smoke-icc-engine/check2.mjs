export default async function (page, logs) {
  const r = await page.evaluate(async () => {
    const P = await import('/lib/color/pipeline.js');
    await P.colorEngine().ready();
    const T = await import('/lib/color/transforms.js');
    const { builtinIcc } = await import('/lib/color/profiles.js');
    const p3 = { id: 'display-p3', bytes: builtinIcc('display-p3'), wellKnown: 'display-p3' };
    const t = T.makeTransform(p3, null);
    const c = document.createElement('canvas'); c.width = 2000; c.height = 2000;
    const g = c.getContext('2d', { willReadFrequently: true }); const grad = g.createLinearGradient(0,0,2000,2000); grad.addColorStop(0,'#ff0000'); grad.addColorStop(0.5,'#20c040'); grad.addColorStop(1,'#1030ff'); g.fillStyle = grad; g.fillRect(0,0,2000,2000);
    const k = document.createElement('canvas'); k.width = 2000; k.height = 2000; const kg = k.getContext('2d', { willReadFrequently: true });
    const out = [];
    for (let i = 0; i < 6; i++) {
      const t0 = performance.now(); const img = g.getImageData(0,0,2000,2000); const t1 = performance.now(); t.apply(img.data, img.data, 4e6); const t2 = performance.now(); kg.putImageData(img, 0, 0); const t3 = performance.now();
      out.push([t1-t0, t2-t1, t3-t2].map((v) => Math.round(v)));
    }
    return out;
  });
  console.log(JSON.stringify(r));
}
