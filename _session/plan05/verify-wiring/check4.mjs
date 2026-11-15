export default async function (page, logs) {
  const res = await page.evaluate(async () => {
    const app = window.pigmentApp;
    const { RasterLayer, createCanvas } = await import('/lib/document.js');
    const { structural } = await import('/lib/layer-ops.js');
    app.newDocument({ width: 200, height: 150, name: 't' });
    const c = createCanvas(80, 60); const x = c.getContext('2d'); x.fillStyle = '#f00'; x.fillRect(0, 0, 80, 60);
    structural(app, 'Add', () => { const l = new RasterLayer({ name: 'R', canvas: c, x: 20, y: 20 }); app.doc.add(l); app.doc.setActive(l); });
    app.tools.activate('move');
    await app.commands.run('edit:free-transform', undefined, 'menu');
    await new Promise((r) => setTimeout(r, 200));
    const active = () => !!app.transformTool?.session || !!app.sessions?.activeEntries?.().length;
    const before = { session: active(), hist: app.doc.history.entries.length };
    // what app.js does with a key main.js took (Shift+Alt+Q on Windows and Linux)
    const cmd = app.keymap.resolveKey('tool:blend-mode-behind', 'key');
    app.commands.run(cmd, undefined, 'key');
    await new Promise((r) => setTimeout(r, 200));
    const afterQ = { cmd, session: active(), hist: app.doc.history.entries.length };
    // a 0.4 key for comparison, a disabled layer command (Shift+Alt+N, layer:blend-mode-normal is enabled though)
    return { before, afterQ };
  });
  console.log(JSON.stringify(res));
}
