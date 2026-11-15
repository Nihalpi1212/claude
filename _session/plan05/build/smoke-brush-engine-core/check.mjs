export default async function (page, logs) {
  await page.evaluate(() => window.pigmentApp.newDocument({ width: 4000, height: 4000, background: 'white' }));
  await page.waitForSelector('.doc-frame:not([hidden]) canvas.view');
  await page.evaluate(async () => {
    const app = window.pigmentApp;
    const { setToolBrush } = await import('/lib/brush/tool-brush.js');
    const { normalizeBrush } = await import('/lib/brush/preset.js');
    const D = await import('/lib/document.js');
    const tile = D.createCanvas(64, 64);
    const g = tile.getContext('2d');
    g.fillStyle = '#808080'; g.fillRect(0,0,64,64);
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, 32, 32); g.fillRect(32, 32, 32, 32);
    const preset = await app.patterns.define(tile, { name: 'Checks' });
    app.tools.activate('brush');
    setToolBrush(app, 'brush', normalizeBrush({ tip: { size: 2500, hardness: 0, spacing: 0.05 }, texture: { enabled: true, pattern: { presetId: preset.id, name: 'Checks' }, scale: 1, depth: 1, eachTip: true } }), { includeTool: false });
    app.doc.view.setZoom(0.15);
    app.doc.view.paint();
    const c = app.doc.view.compositor;
    let n = c.fullRuns;
    window.__stacks = [];
    Object.defineProperty(c, 'fullRuns', { get: () => n, set: (v) => { n = v; window.__stacks.push(new Error().stack.split('\n').slice(2, 9).join('\n')); } });
  });
  const box = await page.locator('.doc-frame:not([hidden]) canvas.view').boundingBox();
  const sp = async (x, y) => page.evaluate(([x, y]) => { const v = window.pigmentApp.doc.view; const r = v.canvas.getBoundingClientRect(); const s = v.toScreen ? v.toScreen(x, y) : null; return s ? { x: r.left + s.x, y: r.top + s.y } : null; }, [x, y]);
  const a = await sp(600, 600), b = await sp(3400, 3400);
  logs.push(JSON.stringify({ a, b }));
  const t0 = Date.now();
  await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, { steps: 10 }); await page.mouse.up();
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  logs.push('elapsed ' + (Date.now() - t0));
  logs.push(JSON.stringify(await page.evaluate(() => window.__stacks), null, 1));
}
