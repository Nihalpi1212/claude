export default async function (page, logs) {
  await page.evaluate(() => window.pigmentApp.newDocument({ width: 2000, height: 1500, name: 'B', background: 'white' }));
  await page.waitForSelector('.doc-frame:not([hidden]) canvas.view');
  const r = await page.evaluate(async () => {
    const app = window.pigmentApp;
    app.tools.activate('brush');
    app.tools.setOpt('brush', 'size', 300);
    app.tools.setOpt('brush', 'hardness', 0.5);
    app.tools.setOpt('brush', 'roundness', 0.5);
    app.tools.setOpt('brush', 'angle', 30);
    app.view.pointer = { x: 1000, y: 700 };
    const c = document.createElement('canvas'); c.width = 1200; c.height = 800;
    const ctx = c.getContext('2d');
    const tool = app.tools.get('brush');
    const time = (n, f) => { for (let i = 0; i < 50; i++) f(); const t0 = performance.now(); for (let i = 0; i < n; i++) f(); return (performance.now() - t0) / n; };
    const { drawBrushCursor } = await import('/lib/brush-cursor.js');
    const out = {};
    out.outline = time(2000, () => tool.drawOverlay(ctx, app.view));
    app.settings.cursorStyle = 'full';
    out.full = time(2000, () => tool.drawOverlay(ctx, app.view));
    // 0.4's cursor for comparison: two arcs
    out.classic = time(2000, () => { const p = app.view.toScreen(1000, 700); ctx.save(); ctx.beginPath(); ctx.arc(p.x, p.y, 150, 0, 7); ctx.stroke(); ctx.beginPath(); ctx.arc(p.x, p.y, 151, 0, 7); ctx.stroke(); ctx.restore(); });
    // a setOpt between frames (the cache is rebuilt)
    let s = 300;
    out.afterSetOpt = time(500, () => { app.tools.setOpt('brush', 'size', (s = s === 300 ? 301 : 300)); tool.drawOverlay(ctx, app.view); });
    out.setOptOnly = time(500, () => { app.tools.setOpt('brush', 'size', (s = s === 300 ? 301 : 300)); });
    // a sampled tip (a built-in media brush when present)
    await app.presets.ready('brushes');
    const sampled = app.presets.list('brushes').find((p) => p.data?.tip?.kind === 'sampled');
    if (sampled) {
      await app.commands.run('tool:brush-preset', { id: sampled.id, tool: 'brush' }, 'api');
      const { prepareBrush, toolBrush } = await import('/lib/brush/tool-brush.js');
      await prepareBrush(app, toolBrush(app, 'brush').preset);
      tool.drawOverlay(ctx, app.view);
      out.sampled = time(1000, () => tool.drawOverlay(ctx, app.view));
      out.sampledName = sampled.name;
    }
    // gesture on the stroke path: pointer move through the gesture vs straight to strokeMove
    const p = { x: 500, y: 500, pressure: 1, button: 0, buttons: 1 };
    const g = tool.gesture;
    const calls = [];
    const fake = { strokeDown() {}, strokeMove() {}, strokeUp() {}, doc: app.doc, view: app.view, app, id: 'brush', options: tool.options, opt: (k) => tool.opt(k) };
    const { PaintGesture } = await import('/lib/tools/paint-gesture.js');
    const fg = new PaintGesture(fake);
    fg.down(p);
    out.gestureMove = time(100000, () => fg.move(p, true));
    out.gestureMoveShift = time(100000, () => fg.move({ ...p, shift: true }, true));
    fg.up(p);
    return out;
  });
  console.log(JSON.stringify(r, null, 1));
}
