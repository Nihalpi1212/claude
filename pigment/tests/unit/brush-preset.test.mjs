// The BrushPreset schema and the tool's brush (ARCHITECTURE.md "0.5 features", S1; skeleton step 4).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_BRUSH, BRUSH_SECTIONS, CONTROL_TYPES, TEXTURE_MODES, DUAL_MODES, RANGES,
  normalizeBrush, brushFromLegacy, legacyTip, splitStrokeSettings, brushEquals, sectionDiff, withSections, clearControls, blobsOf, withoutSampleData,
} from '../../src/renderer/lib/brush/preset.js';
import { toolBrush, setToolBrush, supportsBrush, clampBrushToTool } from '../../src/renderer/lib/brush/tool-brush.js';

test('DEFAULT_BRUSH: every section off, the schema defaults, frozen', () => {
  assert.equal(DEFAULT_BRUSH.brushVersion, 1);
  assert.deepEqual(DEFAULT_BRUSH.tip, { kind: 'computed', size: 24, hardness: 0.8, sample: null, angle: 0, roundness: 1, flipX: false, flipY: false, spacing: 0.12, spacingOn: true });
  for (const id of ['shapeDynamics', 'scattering', 'texture', 'dualBrush', 'colorDynamics', 'transfer', 'brushPose']) assert.equal(DEFAULT_BRUSH[id].enabled, false, id);
  for (const id of ['noise', 'wetEdges', 'buildUp', 'smoothCurves', 'protectTexture']) assert.equal(DEFAULT_BRUSH[id], false, id);
  assert.equal(DEFAULT_BRUSH.tool, null);
  assert.deepEqual(DEFAULT_BRUSH.shapeDynamics.sizeControl, { type: 'off', fadeSteps: 25 });
  assert.ok(Object.isFrozen(DEFAULT_BRUSH) && Object.isFrozen(DEFAULT_BRUSH.tip));
  assert.throws(() => {
    'use strict';
    DEFAULT_BRUSH.tip.size = 3;
  });
});

test('BRUSH_SECTIONS, the enums and RANGES', () => {
  assert.deepEqual(BRUSH_SECTIONS.map((s) => s.id), ['tip', 'shapeDynamics', 'scattering', 'texture', 'dualBrush', 'colorDynamics', 'transfer', 'brushPose', 'noise', 'wetEdges', 'buildUp', 'smoothCurves', 'protectTexture']);
  assert.equal(BRUSH_SECTIONS[0].label, 'Brush Tip Shape');
  assert.equal(BRUSH_SECTIONS.find((s) => s.id === 'smoothCurves').label, 'Smoothing');
  assert.equal(BRUSH_SECTIONS[0].toggle, false);
  assert.ok(BRUSH_SECTIONS.slice(1).every((s) => s.toggle));
  assert.deepEqual(CONTROL_TYPES, ['off', 'fade', 'pen-pressure', 'pen-tilt', 'stylus-wheel', 'rotation', 'initial-direction', 'direction', 'initial-rotation']);
  assert.equal(TEXTURE_MODES.length, 10);
  assert.equal(DUAL_MODES.length, 8);
  assert.deepEqual(RANGES['tip.size'], [1, 5000]);
  assert.deepEqual(RANGES['tip.roundness'], [0.01, 1]);
  assert.deepEqual(RANGES['tip.spacing'], [0.01, 10]);
  assert.deepEqual(RANGES['scattering.scatter'], [0, 10]);
  assert.deepEqual(RANGES['scattering.count'], [1, 16]);
  assert.deepEqual(RANGES['shapeDynamics.tiltScale'], [0, 2]);
  assert.deepEqual(RANGES['texture.brightness'], [-150, 150]);
  assert.deepEqual(RANGES['texture.contrast'], [-50, 100]);
  assert.deepEqual(RANGES['colorDynamics.purity'], [-1, 1]);
  assert.deepEqual(RANGES['brushPose.rotation'], [0, 360]);
  assert.deepEqual(RANGES['transfer.minimumFlow'], [0, 1]);
  // every numeric field of the defaults has a range
  const walk = (o, path) => {
    for (const [k, v] of Object.entries(o)) {
      const p = path ? `${path}.${k}` : k;
      if (typeof v === 'number' && k !== 'brushVersion' && k !== 'fadeSteps') assert.ok(RANGES[p], `RANGES['${p}']`);
      else if (v && typeof v === 'object') walk(v, p);
    }
  };
  walk(DEFAULT_BRUSH, '');
});

test('normalizeBrush: defaults filled, ranges clamped, unknown keys kept in extras, never throws', () => {
  for (const bad of [null, undefined, 3, 'x', [], { tip: 'no' }]) assert.deepEqual(normalizeBrush(bad).tip, DEFAULT_BRUSH.tip);
  const n = normalizeBrush({
    tip: { size: 9000, hardness: -1, roundness: 0, angle: 400, spacing: 0, flipX: 'yes', sample: { blob: 'tip-a.png', hash: 'a', width: 10, height: 20, dataUrl: 'data:image/png;base64,AA' } },
    scattering: { enabled: true, scatter: 50, count: 40.4, countControl: 'pen-pressure', glitter: 3 },
    texture: { enabled: true, mode: 'nonsense', pattern: { presetId: 'p1', name: 'Clouds' }, brightness: -900 },
    shapeDynamics: { sizeControl: { type: 'fade', fadeSteps: 0 } },
    noise: 1, wetEdges: true,
    tool: { opacity: 2, flow: 0.4, blend: 'multiply', color: '#ABCDEF', junk: 1 },
    newSection: { a: 1 },
  });
  assert.equal(n.tip.size, 5000);
  assert.equal(n.tip.hardness, 0);
  assert.equal(n.tip.roundness, 0.01);
  assert.equal(n.tip.angle, 180);
  assert.equal(n.tip.spacing, 0.01);
  assert.equal(n.tip.flipX, false); // not a boolean: the default
  assert.deepEqual(n.tip.sample, { blob: 'tip-a.png', hash: 'a', width: 10, height: 20, dataUrl: 'data:image/png;base64,AA' });
  assert.equal(n.scattering.scatter, 10);
  assert.equal(n.scattering.count, 16);
  assert.deepEqual(n.scattering.countControl, { type: 'pen-pressure', fadeSteps: 25 });
  assert.deepEqual(n.extras.scattering, { glitter: 3 });
  assert.deepEqual(n.extras.newSection, { a: 1 });
  assert.equal(n.texture.mode, 'multiply');
  assert.deepEqual(n.texture.pattern, { presetId: 'p1', name: 'Clouds' });
  assert.equal(n.texture.brightness, -150);
  assert.deepEqual(n.shapeDynamics.sizeControl, { type: 'fade', fadeSteps: 1 });
  assert.equal(n.noise, false);
  assert.equal(n.wetEdges, true);
  assert.deepEqual(n.tool, { opacity: 1, flow: 0.4, blend: 'multiply', color: '#abcdef' });
  // idempotent
  assert.deepEqual(normalizeBrush(n), n);
  // a tip kind this release does not know keeps its fields
  const e = normalizeBrush({ tip: { kind: 'bristle', size: 30, bristles: 40, length: 0.5 } });
  assert.equal(e.tip.kind, 'bristle');
  assert.deepEqual(e.tip.extras, { bristles: 40, length: 0.5 });
  // a cyclic value does not throw
  const cyc = { tip: { size: 10 } };
  cyc.self = cyc;
  assert.doesNotThrow(() => normalizeBrush(cyc));
  assert.equal(normalizeBrush(cyc).brushVersion, 1);
});

test('brushFromLegacy: 0.4 presets and stroke settings; a 0.4 flat object goes through it', () => {
  const p = brushFromLegacy({ id: 'airbrush', name: 'Airbrush Soft 65 (low flow)', size: 65, hardness: 0, flow: 0.12, spacing: 0.08 });
  assert.deepEqual(legacyTip(p), { size: 65, hardness: 0, spacing: 0.08, angle: 0, roundness: 1 });
  assert.deepEqual(p.tool, { flow: 0.12 });
  // 0.4's Brushes panel set flow 1 on a pick of a preset without one
  assert.deepEqual(brushFromLegacy({ id: 'hard-9', name: 'Hard Round 9', size: 9, hardness: 1 }).tool, { flow: 1 });
  // stroke settings: the flow is the stroke's, not the preset's
  const s = brushFromLegacy({ size: 30, hardness: 0.6, angle: 45, roundness: 0.3, flow: 0.5, opacity: 0.8, mode: 'paint', color: '#ff0000' });
  assert.equal(s.tool, null);
  assert.deepEqual(legacyTip(s), { size: 30, hardness: 0.6, spacing: 0.12, angle: 45, roundness: 0.3 });
  assert.deepEqual(normalizeBrush({ size: 30, hardness: 0.6, angle: 45, roundness: 0.3, flow: 0.5, opacity: 0.8, mode: 'paint' }), s);
});

test('splitStrokeSettings: the flat tip keys win over the preset, every other key is paint', () => {
  const preset = normalizeBrush({ tip: { size: 80, hardness: 0.2, spacing: 0.3, angle: 10, roundness: 0.5 }, scattering: { enabled: true, scatter: 2 } });
  const { preset: p, paint } = splitStrokeSettings({ preset, size: 16, hardness: 1, opacity: 0.6, flow: 1, smoothing: 0, antialias: false, label: 'Eraser' });
  assert.equal(p.tip.size, 16);
  assert.equal(p.tip.hardness, 1);
  assert.equal(p.tip.spacing, 0.3);
  assert.equal(p.tip.angle, 10);
  assert.equal(p.scattering.scatter, 2);
  assert.deepEqual(paint, { opacity: 0.6, flow: 1, smoothing: 0, antialias: false, label: 'Eraser' });
  // the preset passed in is not changed
  assert.equal(preset.tip.size, 80);
  // without a preset: 0.4's flat form
  const legacy = splitStrokeSettings({ size: 20, hardness: 1, spacing: 0.5, color: '#000000', mode: 'erase' });
  assert.deepEqual(legacyTip(legacy.preset), { size: 20, hardness: 1, spacing: 0.5, angle: 0, roundness: 1 });
  assert.deepEqual(legacy.paint, { color: '#000000', mode: 'erase' });
  // a sampler and other functions stay paint
  const fn = () => {};
  assert.equal(splitStrokeSettings({ size: 3, sampler: fn }).paint.sampler, fn);
});

test('brushEquals, sectionDiff, withSections, clearControls, blobsOf, withoutSampleData', () => {
  const a = normalizeBrush({ tip: { size: 30 } });
  const b = normalizeBrush({ tip: { size: 30 }, scattering: { enabled: true, scatter: 1 }, buildUp: true });
  assert.equal(brushEquals(a, normalizeBrush({ tip: { size: 30 } })), true);
  assert.equal(brushEquals(a, b), false);
  assert.deepEqual(sectionDiff(a, b), ['scattering', 'buildUp']);
  assert.deepEqual(sectionDiff(a, normalizeBrush({ tip: { size: 31 } })), ['tip']);
  // a sample's data URL is transport, not content
  const s1 = normalizeBrush({ tip: { kind: 'sampled', sample: { blob: 'tip-x.png', hash: 'x', width: 4, height: 4 } } });
  const s2 = normalizeBrush({ tip: { kind: 'sampled', sample: { blob: 'tip-x.png', hash: 'x', width: 4, height: 4, dataUrl: 'data:image/png;base64,AA' } } });
  assert.deepEqual(sectionDiff(s1, s2), []);
  const w = withSections(a, b, ['scattering']);
  assert.equal(w.scattering.enabled, true);
  assert.equal(w.buildUp, false);
  assert.equal(w.tip.size, 30);
  const c = clearControls(b);
  assert.equal(c.scattering.enabled, false);
  assert.equal(c.buildUp, false);
  assert.equal(c.scattering.scatter, 1); // values kept, only the toggles off
  assert.deepEqual(c.tip, b.tip);
  const dual = normalizeBrush({ tip: { kind: 'sampled', sample: { blob: 'tip-a.png', hash: 'a', width: 1, height: 1 } }, dualBrush: { tip: { kind: 'sampled', sample: { blob: 'tip-b.png', hash: 'b', width: 1, height: 1 } } } });
  assert.deepEqual(blobsOf(dual), ['tip-a.png', 'tip-b.png']);
  assert.deepEqual(blobsOf(a), []);
  assert.equal(withoutSampleData(s2).tip.sample.dataUrl, undefined);
});

// ---- the tool's brush over a fake app ------------------------------------------------------------------------

function fakeApp({ tools = {}, settings = {} } = {}) {
  const events = [];
  const opt = (toolId, key) => {
    const stored = app.settings.tools?.[toolId];
    if (stored && key in stored) return stored[key];
    return app.tools.get(toolId)?.options.find((o) => o.key === key)?.default;
  };
  const app = {
    settings: { tools: {}, brushes: { locks: {} }, ...settings },
    saved: [],
    saveSettingsSoon(patch) {
      Object.assign(app.settings, patch);
      app.saved.push(patch);
    },
    emit: (name, detail) => events.push([name, detail]),
    events,
    colors: null,
    setColors(c) {
      app.colors = c;
    },
    tools: {
      active: null,
      get: (id) => tools[id] ?? null,
      opt,
      updated: [],
      updateControl(key) {
        app.tools.updated.push(key);
      },
      updateCursor() {},
    },
    view: null,
  };
  return app;
}
const strokeTool = (id, options) => ({ id, options, baseSettings() {}, strokeSettings() {} });
const BRUSHLIKE = [{ key: 'size', default: 24, min: 1, max: 5000 }, { key: 'hardness', default: 0.8, min: 0, max: 1 }, { key: 'opacity', default: 1 }, { key: 'flow', default: 1, min: 0.01, max: 1 }, { key: 'smoothing', default: 0.2 }];

test('supportsBrush: full for stroke tools with a size, tip for the DabTool family, false otherwise', () => {
  assert.equal(supportsBrush(strokeTool('brush', BRUSHLIKE)), 'full');
  assert.equal(supportsBrush({ ...strokeTool('blur', [{ key: 'size', max: 1000 }]), dabAt() {} }), 'tip');
  assert.equal(supportsBrush({ id: 'move', options: [] }), false);
  assert.equal(supportsBrush(strokeTool('x', [])), false);
  assert.equal(supportsBrush(null), false);
});

test('toolBrush: the flat keys win, spacing falls back to the brush, then settings.brush, then 0.12', () => {
  const app = fakeApp({ tools: { brush: strokeTool('brush', BRUSHLIKE) }, settings: { brush: { spacing: 0.2 } } });
  let tb = toolBrush(app, 'brush');
  assert.deepEqual(legacyTip(tb.preset), { size: 24, hardness: 0.8, spacing: 0.2, angle: 0, roundness: 1 });
  assert.deepEqual(tb.paint, { opacity: 1, flow: 1, blend: 'normal', smoothing: 0.2, smoothingOptions: { mode: 'average', catchUp: false, catchUpOnEnd: false, adjustForZoom: true }, pressureSize: true, pressureOpacity: false, lockAlpha: false });
  app.settings.tools.brush = { size: 40, angle: 30, brush: normalizeBrush({ tip: { size: 99, spacing: 0.4, roundness: 0.5 } }) };
  tb = toolBrush(app, 'brush');
  assert.deepEqual(legacyTip(tb.preset), { size: 40, hardness: 0.8, spacing: 0.4, angle: 30, roundness: 0.5 });
  app.settings.tools.brush.spacing = 0.07;
  assert.equal(toolBrush(app, 'brush').preset.tip.spacing, 0.07);
  delete app.settings.brush;
  delete app.settings.tools.brush;
  assert.equal(toolBrush(app, 'brush').preset.tip.spacing, 0.12);
});

test('setToolBrush: one write of brush, flat keys and presetId; locks, tool values, clamping, Protect Texture', () => {
  const blur = { ...strokeTool('blur', [{ key: 'size', default: 40, min: 1, max: 1000 }, { key: 'hardness', default: 0.5 }]), dabAt() {} };
  const app = fakeApp({ tools: { brush: strokeTool('brush', BRUSHLIKE), blur } });
  app.tools.active = app.tools.get('brush');
  setToolBrush(app, 'brush', normalizeBrush({ tip: { size: 65, hardness: 0, spacing: 0.08, angle: 20, roundness: 0.4 }, tool: { flow: 0.12, opacity: 0.5, color: '#112233' } }), { presetId: 'airbrush' });
  const s = app.settings.tools.brush;
  assert.equal(app.saved.length, 1);
  assert.deepEqual([s.size, s.hardness, s.spacing, s.angle, s.roundness, s.flow, s.opacity], [65, 0, 0.08, 20, 0.4, 0.12, 0.5]);
  assert.equal(s.brushPresetId, 'airbrush');
  assert.equal(s.brush.tip.size, 65);
  assert.deepEqual(app.colors, { foreground: '#112233' });
  assert.deepEqual(app.tools.updated, ['size', 'hardness', 'angle', 'roundness', 'spacing', 'opacity', 'flow']);
  const ev = app.events.find(([n]) => n === 'tool:options');
  assert.equal(ev[1].tool, 'brush');
  assert.equal(ev[1].key, 'brush');
  assert.equal(ev[1].presetId, 'airbrush');
  // an edit keeps brushPresetId; the "modified" mark is a section difference with the stored preset
  app.settings.tools.brush.size = 80; // the [ ] keys
  setToolBrush(app, 'brush', toolBrush(app, 'brush').preset, { includeTool: false });
  assert.equal(app.settings.tools.brush.brushPresetId, 'airbrush');
  assert.deepEqual(sectionDiff(toolBrush(app, 'brush').preset, brushFromLegacy({ id: 'airbrush', size: 65, hardness: 0, flow: 0.12, spacing: 0.08, angle: 20, roundness: 0.4 })), ['tip']);
  // includeTool: false leaves opacity and flow
  assert.equal(app.settings.tools.brush.flow, 0.12);
  // a DabTool: size clamped to its own option, angle / roundness / spacing not written, nothing the tool lacks
  setToolBrush(app, 'blur', normalizeBrush({ tip: { size: 2500, hardness: 0.3, angle: 45 }, tool: { flow: 0.5 } }));
  assert.equal(app.settings.tools.blur.size, 1000);
  assert.equal(app.settings.tools.blur.hardness, 0.3);
  assert.equal('angle' in app.settings.tools.blur, false);
  assert.equal('flow' in app.settings.tools.blur, false);
  // the stored brush holds the clamped size too, and a fresh pick of a 2500 px preset is not "modified" (S1.3)
  assert.equal(app.settings.tools.blur.brush.tip.size, 1000);
  const big = normalizeBrush({ tip: { size: 2500, hardness: 0.3, angle: 45 }, tool: { flow: 0.5 } }); // the pick above
  assert.equal(clampBrushToTool(app, 'blur', big).tip.size, 1000);
  assert.deepEqual(sectionDiff(toolBrush(app, 'blur').preset, clampBrushToTool(app, 'blur', big)), []);
  assert.equal(clampBrushToTool(app, 'brush', big).tip.size, 2500);
  // locks: the locked sections keep the current brush's values
  app.settings.brushes.locks = { scattering: true };
  setToolBrush(app, 'brush', normalizeBrush({ tip: { size: 10 }, scattering: { enabled: true, scatter: 3 } }));
  assert.equal(toolBrush(app, 'brush').preset.scattering.enabled, false);
  setToolBrush(app, 'brush', normalizeBrush({ tip: { size: 10 }, scattering: { enabled: true, scatter: 3 } }), { respectLocks: false });
  assert.equal(toolBrush(app, 'brush').preset.scattering.scatter, 3);
  app.settings.brushes.locks = {};
  // Protect Texture: the current pattern and scale stay when the incoming brush has a texture
  setToolBrush(app, 'brush', normalizeBrush({ protectTexture: true, texture: { enabled: true, pattern: { presetId: 'p-old', name: 'Old' }, scale: 2 } }));
  setToolBrush(app, 'brush', normalizeBrush({ texture: { enabled: true, pattern: { presetId: 'p-new', name: 'New' }, scale: 0.5, depth: 0.3 } }));
  let t = toolBrush(app, 'brush').preset.texture;
  assert.deepEqual([t.pattern.presetId, t.scale, t.depth], ['p-old', 2, 0.3]);
  // without Protect Texture the incoming pattern wins
  setToolBrush(app, 'brush', normalizeBrush({ texture: { enabled: true, pattern: { presetId: 'p-a', name: 'A' }, scale: 1 } }));
  setToolBrush(app, 'brush', normalizeBrush({ texture: { enabled: true, pattern: { presetId: 'p-b', name: 'B' }, scale: 3 } }));
  t = toolBrush(app, 'brush').preset.texture;
  assert.deepEqual([t.pattern.presetId, t.scale], ['p-b', 3]);
  // the stored brush keeps no sample data URL
  setToolBrush(app, 'brush', normalizeBrush({ tip: { kind: 'sampled', sample: { blob: 'tip-q.png', hash: 'q', width: 2, height: 2 } } }));
  assert.equal(app.settings.tools.brush.brush.tip.sample.blob, 'tip-q.png');
  assert.equal(withoutSampleData({ tip: { kind: 'sampled', sample: { blob: 'tip-q.png', hash: 'q', width: 2, height: 2, dataUrl: 'data:image/png;base64,AA' } } }).tip.sample.dataUrl, undefined);
  assert.equal(app.settings.tools.brush.brush.tip.sample.dataUrl, undefined);
});
