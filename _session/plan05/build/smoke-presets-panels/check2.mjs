export default async function (page, logs) {
  await page.evaluate(() => window.pigmentApp.newDocument({ width: 120, height: 90, name: 'T' }));
  await page.waitForSelector('.doc-frame:not([hidden]) canvas.view');
  const r = await page.evaluate(async () => {
    const app = window.pigmentApp;
    const { Selection } = await import('/lib/selection.js');
    const { RasterLayer, createCanvas } = await import('/lib/document.js');
    const { structural } = await import('/lib/layer-ops.js');
    const c = createCanvas(12, 20); const g = c.getContext('2d'); g.fillStyle = '#000'; g.fillRect(0, 0, 12, 20);
    const layer = new RasterLayer({ name: 'Tip', canvas: c, x: 10, y: 10 });
    structural(app, 'Add', () => { app.doc.add(layer); app.doc.setActive(layer); });
    app.applySelection(Selection.fromRect(app.doc.width, app.doc.height, { x: 8, y: 8, width: 16, height: 24 }), 'replace', 'Rect');
    await app.commands.run('edit:define-brush', { name: 'Sampled' }, 'api');
    await app.presets.ready('brushes');
    const p = app.presets.list('brushes').find((x) => x.name === 'Sampled');
    await app.commands.run('tool:brush-preset', { id: p.id, tool: 'brush' }, 'api');
    await app.commands.run('select:deselect', undefined, 'api');
    app.tools.activate('brush');
    const { toolBrush, prepareBrush, sampleCanvas } = await import('/lib/brush/tool-brush.js');
    const tb = toolBrush(app, 'brush');
    await prepareBrush(app, tb.preset);
    return { tip: tb.preset.tip, paint: tb.paint, decoded: !!sampleCanvas(tb.preset.tip.sample.hash), fg: app.settings.foreground, active: app.doc.active.name };
  });
  console.log(JSON.stringify(r));
  const pt = async (x, y) => page.evaluate(([px, py]) => { const v = window.pigmentApp.view; const p = v.toScreen(px, py); const r = v.canvas.getBoundingClientRect(); return { x: r.left + p.x, y: r.top + p.y }; }, [x, y]);
  const a = await pt(20, 60), b = await pt(100, 60);
  await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, { steps: 12 }); await page.mouse.up();
  await page.waitForTimeout(300);
  const after = await page.evaluate(() => { const l = window.pigmentApp.doc.active; return { name: l.name, px: Array.from(l.canvas.getContext('2d').getImageData(60 - l.x, 60 - l.y, 1, 1).data), w: l.canvas.width, x: l.x, y: l.y, hist: window.pigmentApp.doc.history.entries.map((e) => e.label) }; });
  console.log(JSON.stringify(after));
}
