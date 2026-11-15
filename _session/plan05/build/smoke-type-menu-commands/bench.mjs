export default async function (page, logs) {
  const r = await page.evaluate(async () => {
    const app = window.pigmentApp;
    app.newDocument({ width: 2000, height: 1500 });
    const { TextLayer } = await import('/lib/document.js');
    const M = await import('/lib/type/model.js');
    const out = {};
    const make = (size, text) => {
      const layer = new TextLayer({ content: M.fromPlain(text, { size, color: '#000000', fontFamily: 'SourceSans3VF' }), x: 20, y: 40 });
      app.doc.add(layer);
      return layer;
    };
    const time = (layer, n = 5) => { const t0 = performance.now(); for (let i = 0; i < n; i++) { layer.touch(); layer.render(); } return +((performance.now() - t0) / n).toFixed(1); };
    const cases = { big: [300, 'Big Type\nLine two\nThree'], para: [24, Array(40).fill('The quick brown fox jumps over the lazy dog.').join(' ')] };
    for (const [k, [size, text]] of Object.entries(cases)) {
      const l = make(size, text);
      if (k === 'para') { l.width = 1800; l.touch(); }
      out[k] = { smooth: time(l) };
      l.typeOptions = M.normalizeTypeOptions({ ...l.typeOptions, antiAlias: 'none' }); out[k].none = time(l);
      l.typeOptions = M.normalizeTypeOptions({ ...l.typeOptions, antiAlias: 'smooth', warp: { style: 'arc', bend: 50 } }); out[k].warpSmooth = time(l);
      l.typeOptions = M.normalizeTypeOptions({ ...l.typeOptions, antiAlias: 'none' }); out[k].warpNone = time(l);
      l.transform = [0.9, 0.3, -0.3, 0.9, 100, 50]; out[k].warpNoneTransformed = time(l);
      l.typeOptions = M.normalizeTypeOptions({ antiAlias: 'smooth' }); l.transform = null; out[k].smoothAgain = time(l);
      const t0 = performance.now(); for (let i = 0; i < 200; i++) { l.touch(); l.bounds(); } out[k].boundsSmooth = +((performance.now() - t0) / 200).toFixed(3);
      l.typeOptions = M.normalizeTypeOptions({ warp: { style: 'arc', bend: 50 } });
      const t1 = performance.now(); for (let i = 0; i < 200; i++) { l.bounds(); } out[k].boundsWarpCached = +((performance.now() - t1) / 200).toFixed(3);
    }
    return out;
  });
  console.log(JSON.stringify(r, null, 1));
}
