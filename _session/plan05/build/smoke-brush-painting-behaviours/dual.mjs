export default async function (page) {
  await page.evaluate(() => window.pigmentApp.newDocument({ width: 420, height: 400, name: 'B', background: 'transparent' }));
  await page.waitForSelector('.doc-frame:not([hidden]) canvas.view');
  const r = await page.evaluate(async () => {
    const app = window.pigmentApp;
    const { setToolBrush } = await import('/lib/brush/tool-brush.js');
    const { normalizeBrush } = await import('/lib/brush/preset.js');
    const run = (preset, y, pass) => {
      app.tools.activate('brush');
      setToolBrush(app, 'brush', normalizeBrush(preset), { includeTool: false, respectLocks: false });
      for (const [k, v] of Object.entries({ opacity: 1, flow: 1, smoothing: 0, pressureSize: true })) app.tools.setOpt('brush', k, v);
      const tool = app.tools.get('brush');
      const pts = Array.from({ length: 86 }, (_, i) => ({ x: 40 + i * 4, y, pressure: 1, button: 0, buttons: 1 }));
      if (pass) { tool.strokeDown(pts[0]); for (const p of pts.slice(1)) tool.strokeMove(p, true); tool.strokeUp(pts[pts.length - 1]); }
      else { tool.onPointerDown(pts[0]); for (const p of pts.slice(1)) tool.onPointerMove(p, true); tool.onPointerUp(pts[pts.length - 1]); }
      const l = app.doc.active;
      const d = l.canvas.getContext('2d').getImageData(120 - l.x, y - l.y, 160, 1).data;
      let s = 0; for (let i = 3; i < d.length; i += 4) s += d[i];
      return s;
    };
    const base = { tip: { size: 40, hardness: 1, spacing: 0.1 } };
    const dual = { ...base, dualBrush: { enabled: true, mode: 'multiply', tip: { size: 6, hardness: 1, spacing: 0.5 }, scatter: 1, count: 2 } };
    const out = { gesture: [], direct: [] };
    let y = 30;
    for (let i = 0; i < 6; i++) { out.gesture.push(run(dual, y, false)); y += 60; if (y > 380) { app.doc.active.canvas.getContext('2d').clearRect(0,0,9999,9999); y = 30; } }
    for (let i = 0; i < 6; i++) { out.direct.push(run(dual, y, true)); y += 60; if (y > 380) { app.doc.active.canvas.getContext('2d').clearRect(0,0,9999,9999); y = 30; } }
    out.plain = run(base, 370, true);
    return out;
  });
  console.log(JSON.stringify(r));
}
