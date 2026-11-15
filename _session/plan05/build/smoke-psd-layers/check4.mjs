export default async function (page) {
  const r = await page.evaluate(async () => {
    const app = window.pigmentApp;
    const D = await import('/lib/document.js');
    const io = await import('/lib/io.js');
    const comp = (d) => (d.view?.compositor ?? app.view.compositor).composite(d).getContext('2d').getImageData(0, 0, d.width, d.height).data;
    app.newDocument({ width: 200, height: 150, name: 't', background: 'white' });
    const d = app.doc;
    const tri = { subpaths: [{ closed: true, points: [{ x: 150, y: 10 }, { x: 190, y: 50 }, { x: 140, y: 40, inX: 160, inY: 50 }] }] };
    const o = new D.ShapeLayer({ name: 'Path', path: tri, stroke: { width: 2, align: 'center', cap: 'butt', join: 'miter', miterLimit: 4, dash: [], dashOffset: 0, color: '#000000', paint: { type: 'solid', color: '#000000' } } });
    o.fill = null;
    d.add(o);
    const back = io.readPsdDocument(io.writePsdDocument(d, d.view.compositor, { notices: false }));
    app.docs.add(back, { activate: false });
    const a = comp(d), b = comp(back);
    let m = 0, at = null; for (let i = 0; i < a.length; i++) { const v = Math.abs(a[i] - b[i]); if (v > m) { m = v; at = [(i >> 2) % 200, Math.floor((i >> 2) / 200)]; } }
    const L = back.layers()[1];
    return { m, at, path: L.path, stroke: L.stroke, b: L.bounds(), ob: o.bounds() };
  });
  console.log(JSON.stringify(r));
}
