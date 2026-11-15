export default async function (page, logs) {
  const r = await page.evaluate(async () => {
    const app = window.pigmentApp;
    app.newDocument({ width: 400, height: 300 });
    const { TextLayer } = await import('/lib/document.js');
    const M = await import('/lib/type/model.js');
    const out = { stubbed: app.stubbed.filter((x) => x.startsWith('type:') || x.startsWith('tool:type')) };
    const layer = new TextLayer({ content: M.fromPlain('Hello', { size: 60, color: '#000000', fontFamily: 'SourceSans3VF' }), x: 20, y: 40 });
    app.doc.add(layer); app.doc.setActive(layer); app.doc.changed('tree');
    await new Promise(r => setTimeout(r, 300));
    const alphas = () => { layer.touch(); const o = layer.render(); const d = o.canvas.getContext('2d').getImageData(0,0,o.canvas.width,o.canvas.height).data; const s = new Set(); let n=0; for (let i=3;i<d.length;i+=4){ s.add(d[i]); if(d[i]) n++;} return { distinct: s.size, n, box: [o.x,o.y,o.canvas.width,o.canvas.height] }; };
    out.smooth = alphas();
    app.commands.run('type:anti-alias', 'none', 'api');
    out.none = alphas();
    out.label = app.doc.history.entries[app.doc.history.index].label;
    app.commands.run('type:anti-alias', 'sharp', 'api');
    out.sharp = alphas();
    app.commands.run('type:warp-text', { style: 'arc', bend: 50 }, 'api');
    out.warpNone = alphas();
    out.wlabel = app.doc.history.entries[app.doc.history.index].label;
    app.commands.run('type:anti-alias', 'smooth', 'api');
    out.warpSmooth = alphas();
    out.bounds = layer.bounds();
    app.commands.run('type:create-work-path', undefined, 'api');
    out.wp = app.doc.workPath?.subpaths.length;
    app.commands.run('type:convert-to-shape', undefined, 'api');
    out.shape = [app.doc.active.type, app.doc.active.path.subpaths.length, app.doc.history.entries[app.doc.history.index].label];
    return out;
  });
  console.log(JSON.stringify(r, null, 1));
}
