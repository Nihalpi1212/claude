export default async function (page, logs) {
  const r = await page.evaluate(async () => {
    const app = window.pigmentApp;
    const D = await import('/lib/document.js');
    const io = await import('/lib/io.js');
    const { readPsd } = await import('ag-psd');
    const out = {};
    const comp = (d) => (d.view?.compositor ?? app.view.compositor).composite(d).getContext('2d').getImageData(0, 0, d.width, d.height).data;
    const diff = (a, b) => { let m = 0, n = 0; for (let i = 0; i < a.length; i++) { const v = Math.abs(a[i] - b[i]); if (v > m) m = v; if (v > 8) n++; } return { max: m, over8: n }; };
    const fill = (w, h, color) => { const c = D.createCanvas(w, h); const x = c.getContext('2d'); x.fillStyle = color; x.fillRect(0, 0, w, h); return c; };
    const roundTrip = (label) => {
      const d = app.doc;
      const before = comp(d);
      const bytes = io.writePsdDocument(d, d.view.compositor, { notices: false });
      const back = io.readPsdDocument(bytes);
      app.docs.add(back, { activate: false });
      const after = comp(back);
      out[label] = { ...diff(before, after), notices: back.openNotices ?? null, layers: back.layers().map((l) => ({ n: l.name, t: l.type, k: l.shapeKind, styles: l.styles ? Object.keys(l.styles) : null, vm: !!l.vectorMask, mask: !!l.mask, color: l.color ?? null, linked: l.linked ?? null, blending: l.blending })) };
      return back;
    };
    // effects
    app.newDocument({ width: 200, height: 150, name: 'fx' });
    let d = app.doc;
    d.add(new D.RasterLayer({ name: 'Box', canvas: fill(80, 60, '#3070c0'), x: 40, y: 30, styles: {
      dropShadow: [{ enabled: true, distance: 8, size: 6, spread: 2, color: '#000000', opacity: 0.6 }, { enabled: true, distance: 3, size: 1, angle: 30, color: '#ff0000' }],
      outerGlow: { enabled: true, size: 10, spread: 3, color: '#ffff00' },
      innerShadow: { enabled: true, distance: 4, size: 4 },
      bevel: { enabled: true, size: 6, depth: 150, technique: 'chisel-soft', style: 'inner-bevel' },
      satin: { enabled: true, size: 10, distance: 8 },
      colorOverlay: { enabled: true, color: '#00ff00', opacity: 0.3 },
      gradientOverlay: { enabled: true, opacity: 0.5, gradient: { gradientVersion: 2, type: 'solid', interpolation: 'perceptual', smoothness: 1, stops: [{ pos: 0, mid: 0.5, color: '#ff00ff' }, { pos: 1, mid: 0.5, color: '#00ffff' }], opacityStops: [{ pos: 0, mid: 0.5, opacity: 1 }, { pos: 1, mid: 0.5, opacity: 1 }] }, angle: 45 },
      stroke: [{ enabled: true, size: 3, color: '#ffffff', position: 'outside' }, { enabled: true, size: 2, color: '#000000', position: 'inside' }],
    }, blending: { knockout: 'shallow', channels: { r: true, g: false, b: true } } }));
    d.globalLight = { angle: 60, altitude: 40 };
    await new Promise((r) => setTimeout(r, 50));
    let back = roundTrip('effects');
    out.effectsBack = { gl: back.globalLight, styles: back.layers().find((l) => l.name === 'Box').styles };
    // shapes, fills
    app.newDocument({ width: 200, height: 150, name: 'shapes' });
    d = app.doc;
    const { livePath } = await import('/lib/path-ops.js');
    const props = { x: 20, y: 20, width: 90, height: 60, angle: 15, radii: [10, 0, 20, 5] };
    d.add(new D.ShapeLayer({ name: 'Rect', path: livePath('rect', props), shapeKind: 'rect', shapeProps: props, fill: { type: 'gradient', gradient: { kind: 'linear', angle: 30, stops: [{ pos: 0, color: '#ff0000' }, { pos: 1, color: '#0000ff' }] } }, stroke: { width: 4, align: 'outside', cap: 'round', join: 'round', miterLimit: 4, dash: [2, 1], dashOffset: 0, color: '#00aa00', paint: { type: 'solid', color: '#00aa00' } } }));
    const eprops = { x: 120, y: 60, width: 60, height: 50, angle: 0 };
    d.add(new D.ShapeLayer({ name: 'Ellipse', path: livePath('ellipse', eprops), shapeKind: 'ellipse', shapeProps: eprops, fill: { type: 'solid', color: '#ffaa00' }, stroke: null }));
    d.add(new D.FillLayer({ name: 'Grad fill', paint: { type: 'gradient', gradient: { kind: 'radial', stops: [{ pos: 0, color: '#ffffff' }, { pos: 1, color: '#000000' }], from: [100, 75], to: [180, 75] } }, docWidth: 200, docHeight: 150, opacity: 0.4 }));
    d.add(new D.FillLayer({ name: 'Solid', paint: { type: 'solid', color: '#204080' }, docWidth: 200, docHeight: 150, opacity: 0.3, color: 'red' }));
    const pc = fill(8, 8, '#ff0000'); pc.getContext('2d').fillStyle = '#ffffff'; pc.getContext('2d').fillRect(0, 0, 4, 4);
    d.add(new D.FillLayer({ name: 'Pattern', paint: { type: 'pattern', pattern: { canvas: pc, scale: 2, angle: 0, link: true, origin: [0, 0], name: 'Checker' } }, docWidth: 200, docHeight: 150, opacity: 0.25 }));
    const ls = d.layers(); ls[1].linked = 'Kx'; ls[2].linked = 'Kx'; ls[1].color = 'violet';
    back = roundTrip('shapes');
    out.shapesBack = back.layers().filter((l) => l.type === 'shape' || l.type === 'fill').map((l) => ({ n: l.name, kind: l.shapeKind, props: l.shapeProps, stroke: l.stroke, fill: l.fill?.type ?? null, paint: l.paint ? { ...l.paint, pattern: l.paint.pattern ? { ...l.paint.pattern, canvas: !!l.paint.pattern.canvas, dataUrl: !!l.paint.pattern.dataUrl } : undefined } : null }));
    // vector masks
    app.newDocument({ width: 120, height: 90, name: 'vm' });
    d = app.doc;
    const rect = (x, y, w, h, op) => ({ closed: true, points: [[x, y], [x + w, y], [x + w, y + h], [x, y + h]].map(([px, py]) => ({ x: px, y: py })), ...(op ? { op } : {}) });
    d.add(new D.RasterLayer({ name: 'VM', canvas: fill(120, 90, '#ff0000'), x: 0, y: 0, vectorMask: { path: { subpaths: [rect(10, 10, 80, 60), rect(30, 30, 20, 20, 'subtract')] }, density: 0.7, feather: 3, initialFill: 'hide' } }));
    d.add(new D.RasterLayer({ name: 'Reveal', canvas: fill(120, 90, '#0000ff'), x: 0, y: 0, opacity: 0.5, vectorMask: { path: { subpaths: [rect(60, 0, 30, 90, 'subtract')] }, initialFill: 'reveal' } }));
    back = roundTrip('vm');
    out.vmBack = back.layers().map((l) => l.vectorMask && { ...l.vectorMask, path: l.vectorMask.path.subpaths.length });
    // adjustments
    app.newDocument({ width: 120, height: 90, name: 'adj' });
    d = app.doc;
    d.add(new D.RasterLayer({ name: 'C', canvas: fill(120, 90, '#c08040'), x: 0, y: 0 }));
    await app.commands.run('layer:new-adjustment', { kind: 'hue-saturation', params: { colorize: true, colorizeHue: 200, colorizeSat: 40, colorizeLight: -10 } }, 'api');
    await app.commands.run('layer:new-adjustment', { kind: 'color-lookup', params: { preset: 'none', lut: null, dither: false } }, 'api');
    back = roundTrip('adj');
    out.adjBack = back.layers().filter((l) => l.type === 'adjustment').map((l) => ({ kind: l.kind, params: l.params }));
    return out;
  });
  console.log(JSON.stringify(r, null, 1).slice(0, 12000));
}
