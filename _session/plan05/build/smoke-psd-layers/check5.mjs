export default async function (page) {
  const r = await page.evaluate(async () => {
    const app = window.pigmentApp;
    const D = await import('/lib/document.js');
    const io = await import('/lib/io.js');
    const { livePath } = await import('/lib/path-ops.js');
    const comp = (d) => (d.view?.compositor ?? app.view.compositor).composite(d).getContext('2d').getImageData(0, 0, d.width, d.height).data;
    app.newDocument({ width: 200, height: 150, name: 't', background: 'white' });
    const d = app.doc;
    const props = { x: 20, y: 20, width: 90, height: 60, angle: 15, radii: [10, 0, 20, 5] };
    d.add(new D.ShapeLayer({ name: 'Rect', path: livePath('rect', props), shapeKind: 'rect', shapeProps: props, fill: { type: 'gradient', gradient: { kind: 'linear', angle: 30, stops: [{ pos: 0, color: '#ff0000' }, { pos: 1, color: '#0000ff' }] } }, stroke: { width: 4, align: 'outside', cap: 'round', join: 'round', miterLimit: 4, dash: [2, 1], dashOffset: 0, color: '#00aa00', paint: { type: 'solid', color: '#00aa00' } } }));
    const back = io.readPsdDocument(io.writePsdDocument(d, d.view.compositor, { notices: false }));
    app.docs.add(back, { activate: false });
    const a = comp(d), b = comp(back);
    let m = 0, at = null, n = 0; for (let i = 0; i < a.length; i++) { const v = Math.abs(a[i] - b[i]); if (v > 2) n++; if (v > m) { m = v; at = [(i >> 2) % 200, Math.floor((i >> 2) / 200), i % 4]; } }
    const L = back.layers()[1];
    return { m, at, n, fill: L.fill, of: d.layers()[1].fill, path0: L.path.subpaths[0].points[0], opath0: d.layers()[1].path.subpaths[0].points[0], b: L.bounds(), ob: d.layers()[1].bounds() };
  });
  console.log(JSON.stringify(r));
}
