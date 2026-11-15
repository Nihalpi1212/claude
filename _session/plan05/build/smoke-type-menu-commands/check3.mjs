export default async function (page, logs) {
  const r = await page.evaluate(async () => {
    const app = window.pigmentApp;
    app.newDocument({ width: 400, height: 300 });
    const out = {};
    const d = app.doc;
    const n0 = d.history.entries.length;
    app.tools.activate('type-mask-horizontal');
    app.tools.setOpt('type-mask-horizontal', 'family', 'SourceSans3VF');
    const t = app.tools.active;
    out.slot = app.tools.slots.find(s => s.id === 'text').tools;
    t.beginNew({ x: 40, y: 150 }, null);
    t.session.editor.insert('Mask');
    out.during = { layers: d.layers().length, opacity: t.session.layer.opacity };
    app.view.invalidate();
    await new Promise(r => setTimeout(r, 200));
    t.commitSession();
    out.after = { layers: d.layers().length, sel: d.selection?.bounds, labels: d.history.entries.slice(n0).map(e => e.label) };
    let vals = new Set(); for (const v of d.selection.mask) vals.add(v);
    out.distinct = vals.size;
    // vertical mask with none AA
    app.tools.activate('type-mask-vertical');
    app.tools.setOpt('type-mask-vertical', 'antiAlias', 'none');
    app.tools.setOpt('type-mask-vertical', 'family', 'SourceSans3VF');
    const v = app.tools.active;
    v.beginNew({ x: 200, y: 20 }, null);
    v.session.editor.insert('VM');
    v.commitSession();
    vals = new Set(); for (const x of d.selection.mask) vals.add(x);
    out.vdistinct = [...vals].sort((a,b)=>a-b);
    out.vsel = d.selection.bounds;
    // Shift+T cycles
    return out;
  });
  console.log(JSON.stringify(r));
}
