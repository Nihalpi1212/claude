export default async function (page, logs) {
  const r = await page.evaluate(async () => {
    const app = window.pigmentApp;
    const { BrushStroke } = await import('/lib/brush.js');
    const { normalizeBrush } = await import('/lib/brush/preset.js');
    const { createCanvas } = await import('/lib/document.js');
    await app.patterns.get('checkerboard');
    const history = { stroke: null, beginStroke: (c) => ({ backup: createCanvas(c.width, c.height) }), endStroke: () => null, cancelStroke() {} };
    const run = (name, preset, { size = 2500, side = 4000, n = 12, frames = true } = {}) => {
      const canvas = createCanvas(side, side);
      const s = new BrushStroke({ target: { canvas, x: 0, y: 0 }, layer: null, history, settings: { preset: normalizeBrush(preset), opacity: 1, flow: 1, smoothing: 0, color: '#000000', mode: 'paint', blend: 'normal', app, seed: 1 } });
      const t0 = performance.now();
      const step = (side - size) / n;
      s.begin({ x: size / 2, y: side / 2 });
      for (let i = 1; i <= n; i++) {
        s.extend({ x: size / 2 + i * step, y: side / 2 });
        if (frames) s.flush();
      }
      s.end();
      const ms = performance.now() - t0;
      return { name, ms: Math.round(ms), perDab: Math.round(ms / Math.max(1, s.dabs)), dabs: s.dabs };
    };
    const tex = (eachTip) => ({ enabled: true, pattern: { presetId: 'checkerboard', name: 'C' }, depth: 1, eachTip });
    const out = [];
    for (const [size, side, sp] of [[2500, 4000, 0.05], [100, 1500, 0.1]]) {
      const tip = { size, hardness: 0, spacing: sp };
      out.push(run(`${size} plain`, { tip }, { size, side }));
      out.push(run(`${size} texture each tip`, { tip, texture: tex(true) }, { size, side }));
      out.push(run(`${size} texture stroke`, { tip, texture: tex(false) }, { size, side }));
      out.push(run(`${size} dual`, { tip, dualBrush: { enabled: true, tip: { size: Math.round(size / 4), spacing: 0.25 }, scatter: 1, count: 2 } }, { size, side }));
      out.push(run(`${size} noise`, { tip, noise: true }, { size, side }));
      out.push(run(`${size} wet`, { tip, wetEdges: true }, { size, side }));
      out.push(run(`${size} pose`, { tip, brushPose: { enabled: true, pressure: 0.8 } }, { size, side }));
    }
    return out;
  });
  for (const x of r) logs.push(JSON.stringify(x));
}
