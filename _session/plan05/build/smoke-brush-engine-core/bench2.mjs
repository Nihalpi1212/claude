export default async function (page, logs) {
  const r = await page.evaluate(async () => {
    const NEW = await import('/lib/brush.js');
    const OLD = await import('/lib/brush/engine-04.bench.js');
    const { createCanvas } = await import('/lib/document.js');
    const { normalizeBrush } = await import('/lib/brush/preset.js');
    const W = 2000, H = 1500;
    const history = { stroke: null, beginStroke: (c) => { const b = createCanvas(c.width, c.height); b.getContext('2d').drawImage(c, 0, 0); return { backup: b }; }, endStroke: () => null, cancelStroke() {} };
    const run = (Engine, settings, n = 240, flushEvery = 4) => {
      const canvas = createCanvas(W, H);
      const g = canvas.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, W, H);
      g.getImageData(0, 0, 1, 1);
      const t0 = performance.now();
      const s = new Engine.BrushStroke({ target: { canvas, x: 0, y: 0 }, layer: null, history, settings });
      let dabs = 0;
      s.begin({ x: 100, y: 100 });
      for (let i = 1; i <= n; i++) {
        const t = i / n;
        s.extend({ x: 100 + t * 1800, y: 750 + Math.sin(t * 6.28) * 500, pressure: 0.5 + 0.5 * Math.sin(t * 3.14) });
        if (i % flushEvery === 0) s.flush();
      }
      s.finish({ x: 1900, y: 750 });
      s.end();
      canvas.getContext('2d').getImageData(0, 0, 1, 1);
      const ms = performance.now() - t0;
      return { ms: +ms.toFixed(0), dabs: s.dabs, perDab: +(ms / s.dabs).toFixed(3) };
    };
    const base = (size, extra = {}) => ({ size, hardness: 0, opacity: 0.8, flow: 0.5, smoothing: 0.2, spacing: 0.12, pressureSize: true, pressureOpacity: false, color: '#d02040', mode: 'paint', blend: 'normal', ...extra });
    const out = {};
    for (const size of [30, 100, 500]) {
      // warm up caches
      run(OLD, base(size), 20); run(NEW.BrushStroke ? NEW : NEW, base(size), 20);
      out[`size ${size}: 0.4`] = run(OLD, base(size));
      out[`size ${size}: 0.5`] = run(NEW, base(size));
      out[`size ${size} no pressure: 0.4`] = run(OLD, base(size, { pressureSize: false }));
      out[`size ${size} no pressure: 0.5`] = run(NEW, base(size, { pressureSize: false }));
    }
    const dyn = normalizeBrush({ tip: { size: 100, hardness: 0.5, spacing: 0.12 }, shapeDynamics: { enabled: true, sizeJitter: 0.5, angleJitter: 0.3, roundnessJitter: 0.3 }, scattering: { enabled: true, scatter: 1, count: 2 }, colorDynamics: { enabled: true, hueJitter: 0.2, fbJitter: 0.3 }, transfer: { enabled: true, opacityJitter: 0.5, flowJitter: 0.5 } });
    const { size: _s, hardness: _h, spacing: _sp, ...paint } = base(100);
    out['size 100 all dynamics: 0.5'] = run(NEW, { ...paint, preset: dyn });
    const nojit = normalizeBrush({ tip: { size: 100, hardness: 0.5, spacing: 0.12 }, shapeDynamics: { enabled: true, sizeJitter: 0.5, angleJitter: 0.3 }, scattering: { enabled: true, scatter: 1, count: 2 }, colorDynamics: { enabled: true, hueJitter: 0.2 } });
    out['size 100 dynamics without Transfer: 0.5'] = run(NEW, { ...paint, preset: nojit });
    run(OLD, base(2500, { spacing: 0.05, pressureSize: false }), 4);
    out['size 2500: 0.4'] = run(OLD, base(2500, { spacing: 0.05, pressureSize: false }), 24, 2);
    run(NEW, base(2500, { spacing: 0.05, pressureSize: false }), 4);
    out['size 2500: 0.5'] = run(NEW, base(2500, { spacing: 0.05, pressureSize: false }), 24, 2);
    return out;
  });
  for (const [k, v] of Object.entries(r)) logs.push(`${k}: ${JSON.stringify(v)}`);
}
