export default async function (page, logs) {
  await page.evaluate(() => window.pigmentApp.newDocument({ width: 4000, height: 4000, background: 'white' }));
  await page.waitForSelector('.doc-frame:not([hidden]) canvas.view');
  await page.evaluate(async () => {
    const app = window.pigmentApp;
    const { setToolBrush } = await import('/lib/brush/tool-brush.js');
    const { normalizeBrush } = await import('/lib/brush/preset.js');
    const E = await import('/lib/brush.js');
    app.tools.activate('brush');
    setToolBrush(app, 'brush', normalizeBrush({ tip: { size: 2500, hardness: 0, spacing: 0.05 } }), { includeTool: false });
    app.doc.view.setZoom(0.15);
    app.doc.view.paint();
    const c = app.doc.view.compositor;
    window.__log = [];
    const T = (obj, name, label) => { const f = obj[name]; obj[name] = function (...a) { const t0 = performance.now(); const r = f.apply(this, a); window.__log.push([label, +(performance.now() - t0).toFixed(1), a[0]?.width ? `${a[0].width}x${a[0].height}` : '']); return r; }; };
    T(E.BrushStroke.prototype, 'paintDab', 'dab');
    T(E.BrushStroke.prototype, 'flush', 'flush');
    T(app.doc.view, 'paint', 'paint');
    T(c, 'composite', 'composite');
    const P = await import('/lib/color/pipeline.js');
    T(app.doc.view, 'composite', 'viewcomposite');
    const comp = c.composite.bind(c);
    let n = c.fullRuns;
    Object.defineProperty(c, 'fullRuns', { get: () => n, set: (v) => { n = v; window.__log.push(['FULL']); } });
  });
  const sp = async (x, y) => page.evaluate(([x, y]) => { const v = window.pigmentApp.doc.view; const r = v.canvas.getBoundingClientRect(); const s = v.toScreen(x, y); return { x: r.left + s.x, y: r.top + s.y }; }, [x, y]);
  const a = await sp(600, 600), b = await sp(3400, 3400);
  const t0 = Date.now();
  await page.mouse.move(a.x, a.y); await page.mouse.down();
  logs.push('down ' + (Date.now() - t0));
  await page.mouse.move(b.x, b.y, { steps: 10 });
  logs.push('moved ' + (Date.now() - t0));
  await page.mouse.up();
  logs.push('up ' + (Date.now() - t0));
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  logs.push('elapsed ' + (Date.now() - t0));
  logs.push(JSON.stringify(await page.evaluate(() => window.__log)));
}
