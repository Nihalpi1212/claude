export default async function (page, logs) {
  const r = await page.evaluate(async () => {
    const app = window.pigmentApp;
    const TB = await import('/lib/brush/tool-brush.js');
    const P = await import('/lib/brush/preset.js');
    const out = {};
    const tools0 = JSON.parse(JSON.stringify(app.settings.tools ?? {}));
    app.settings.tools = { ...tools0, brush: {} };
    out.defaultSpacing = TB.toolBrush(app, 'brush').preset.tip.spacing;
    const brush0 = app.settings.brush;
    app.settings.brush = { ...(brush0 ?? {}), spacing: 0.3 };
    out.legacySpacing = TB.toolBrush(app, 'brush').preset.tip.spacing;
    app.settings.tools.brush = { brush: P.normalizeBrush({ tip: { spacing: 0.5 } }) };
    out.brushSpacing = TB.toolBrush(app, 'brush').preset.tip.spacing;
    app.settings.tools.brush.spacing = 0.05;
    out.flatSpacing = TB.toolBrush(app, 'brush').preset.tip.spacing;
    app.settings.brush = brush0;
    // locks
    app.settings.tools.brush = {};
    app.tools.activate('brush');
    app.tools.setOpt('brush', 'size', 40);
    app.settings.brushes = { ...(app.settings.brushes ?? {}), locks: { tip: true } };
    TB.setToolBrush(app, 'brush', P.normalizeBrush({ tip: { size: 300, hardness: 0.1 }, scattering: { enabled: true, scatter: 2 } }), { presetId: 'x' });
    const tb = TB.toolBrush(app, 'brush');
    out.locked = { size: tb.preset.tip.size, hardness: tb.preset.tip.hardness, scatter: tb.preset.scattering.enabled, optSize: app.tools.opt('brush', 'size'), presetId: app.settings.tools.brush.brushPresetId };
    app.settings.brushes = { ...app.settings.brushes, locks: {} };
    // include tool colour
    const fg0 = app.settings.foreground;
    TB.setToolBrush(app, 'brush', P.normalizeBrush({ tip: { size: 33 }, tool: { opacity: 0.5, color: '#112233' } }));
    out.tool = { opacity: app.tools.opt('brush', 'opacity'), fg: app.settings.foreground, size: app.tools.opt('brush', 'size') };
    app.setColors({ foreground: fg0 });
    // supportsBrush for the toolbox
    out.supports = Object.fromEntries(['brush', 'pencil', 'eraser', 'clone-stamp', 'pattern-stamp', 'history-brush', 'blur', 'smudge', 'dodge', 'healing-brush', 'spot-healing', 'move', 'adjustment-brush', 'color-replacement', 'background-eraser'].map((id) => [id, TB.supportsBrush(app.tools.get(id))]));
    out.allPaintTools = [...app.tools.tools.values()].filter((t) => TB.supportsBrush(t)).map((t) => `${t.id}:${TB.supportsBrush(t)}`);
    // DabTool clamp
    const dab = [...app.tools.tools.values()].find((t) => TB.supportsBrush(t) === 'tip');
    if (dab) { TB.setToolBrush(app, dab.id, P.normalizeBrush({ tip: { size: 3000, hardness: 0.3, angle: 30 } })); out.dab = { id: dab.id, size: app.tools.opt(dab.id, 'size'), stored: app.settings.tools[dab.id] }; }
    // splitStrokeSettings precedence
    const sp = P.splitStrokeSettings({ preset: P.normalizeBrush({ tip: { size: 50, hardness: 0.2 } }), size: 10, flow: 0.4, color: '#ff0000' });
    out.split = { size: sp.preset.tip.size, hardness: sp.preset.tip.hardness, paint: sp.paint };
    const sl = P.splitStrokeSettings({ size: 10, hardness: 0.3, flow: 0.4, mode: 'paint', name: 'x', id: 'y' });
    out.splitLegacy = { tip: sl.preset.tip, tool: sl.preset.tool, paint: sl.paint };
    // normalize: unknown keys to extras; 0.4 flat object
    out.norm = P.normalizeBrush({ tip: { size: 99999, kind: 'bristle', bristles: 4 }, shapeDynamics: { enabled: true, sizeJitter: 3, foo: 1 }, newSection: { a: 1 } });
    out.legacy = P.normalizeBrush({ id: 'a', name: 'A', size: 10, hardness: 0.5, spacing: 0.2, angle: 10, roundness: 0.5, flow: 0.3 });
    out.legacyRT = P.brushFromLegacy({ id: 'a', name: 'A', size: 10, hardness: 0.5 }).tool;
    app.settings.tools = tools0;
    return out;
  });
  console.log(JSON.stringify(r, (k, v) => (k === 'shapeDynamics' || k === 'scattering' || k === 'texture' || k === 'dualBrush' || k === 'colorDynamics' || k === 'transfer' || k === 'brushPose') && v && !v.enabled && !v.foo ? '[off]' : v));
}
