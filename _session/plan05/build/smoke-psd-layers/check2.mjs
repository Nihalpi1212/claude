export default async function (page) {
  const r = await page.evaluate(async () => {
    const app = window.pigmentApp;
    const D = await import('/lib/document.js');
    const io = await import('/lib/io.js');
    const { livePath } = await import('/lib/path-ops.js');
    const comp = (d) => (d.view?.compositor ?? app.view.compositor).composite(d).getContext('2d').getImageData(0, 0, d.width, d.height).data;
    const diff = (a, b, w) => { let m = 0, n = 0, at = null; for (let i = 0; i < a.length; i++) { const v = Math.abs(a[i] - b[i]); if (v > m) { m = v; at = [(i >> 2) % w, Math.floor((i >> 2) / w)]; } if (v > 8) n++; } return { max: m, over8: n, at }; };
    const out = {};
    const props = { x: 20, y: 20, width: 90, height: 60, angle: 15, radii: [10, 0, 20, 5] };
    const eprops = { x: 120, y: 60, width: 60, height: 50, angle: 0 };
    const cases = {
      rectGrad: () => new D.ShapeLayer({ name: 'Rect', path: livePath('rect', props), shapeKind: 'rect', shapeProps: props, fill: { type: 'gradient', gradient: { kind: 'linear', angle: 30, stops: [{ pos: 0, color: '#ff0000' }, { pos: 1, color: '#0000ff' }] } }, stroke: null }),
      rectStroke: () => new D.ShapeLayer({ name: 'Rect', path: livePath('rect', props), shapeKind: 'rect', shapeProps: props, fill: { type: 'solid', color: '#ff0000' }, stroke: { width: 4, align: 'outside', cap: 'round', join: 'round', miterLimit: 4, dash: [2, 1], dashOffset: 0, color: '#00aa00', paint: { type: 'solid', color: '#00aa00' } } }),
      ellipse: () => new D.ShapeLayer({ name: 'Ellipse', path: livePath('ellipse', eprops), shapeKind: 'ellipse', shapeProps: eprops, fill: { type: 'solid', color: '#ffaa00' }, stroke: null }),
      gradFill: () => new D.FillLayer({ name: 'Grad fill', paint: { type: 'gradient', gradient: { kind: 'radial', stops: [{ pos: 0, color: '#ffffff' }, { pos: 1, color: '#000000' }], from: [100, 75], to: [180, 75] } }, docWidth: 200, docHeight: 150 }),
      linFill: () => new D.FillLayer({ name: 'Lin', paint: { type: 'gradient', gradient: { kind: 'linear', stops: [{ pos: 0, color: '#ffffff' }, { pos: 1, color: '#000000' }], from: [20, 30], to: [150, 100] } }, docWidth: 200, docHeight: 150 }),
    };
    for (const [k, make] of Object.entries(cases)) {
      app.newDocument({ width: 200, height: 150, name: k });
      const d = app.doc;
      d.add(make());
      const before = comp(d);
      const back = io.readPsdDocument(io.writePsdDocument(d, d.view.compositor, { notices: false }));
      app.docs.add(back, { activate: false });
      out[k] = diff(before, comp(back), 200);
      const L = back.layers()[1];
      out[k].path = JSON.stringify(L.path ?? null).slice(0, 200);
      out[k].orig = JSON.stringify(d.layers()[1].path ?? null).slice(0, 200);
      out[k].paint = JSON.stringify(L.paint?.gradient ?? L.fill ?? null).slice(0, 300);
    }
    return out;
  });
  console.log(JSON.stringify(r, null, 1));
}
