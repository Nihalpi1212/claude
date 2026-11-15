// psd-layers (ARCHITECTURE.md "0.5 features", package 5): the mappers on ag-psd objects both ways, through ag-psd's own
// writer and reader where the bytes matter (Node loads '#ag-psd' with every fix, S4.5). Canvas-bound paths (shape
// pixels, masks, patterns) are covered by tests/e2e/psd-layers.spec.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const ag = await import('#ag-psd');
await import('../../src/renderer/lib/io.js'); // every mapper registered, as the app has them
const R = await import('../../src/renderer/lib/psd/registry.js');
const E = await import('../../src/renderer/lib/psd/effects.js');
const V = await import('../../src/renderer/lib/psd/vector.js');
const A = await import('../../src/renderer/lib/psd/adjustments.js');
const P = await import('../../src/renderer/lib/psd/paints.js');
const { createReport } = await import('../../src/renderer/lib/psd/report.js');
const { normalizeGradient, gradientLut } = await import('../../src/shared/pixels/gradient-model.js');

const READ = { skipLayerImageData: true, skipCompositeImageData: true, skipThumbnail: true, throwForMissingFeatures: true };
/** Writes layer records with ag-psd and reads them back (the fixed handlers both ways). */
const viaFile = (children, extra = {}) => ag.readPsd(ag.writePsdUint8Array({ width: 100, height: 80, children, ...extra }, { noBackground: true }), READ);
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

test('the flags of S15 are landed and the layer fixes of ag-psd are applied', () => {
  const f = R.psdFeatures();
  for (const k of ['effects', 'advancedBlending', 'vectorMasks', 'shapes', 'fills', 'tags', 'globalLight']) assert.equal(f[k], true, k);
  assert.equal(ag.fixesPatched.layers, true);
  const kinds = R.psdLayerKinds().map((k) => [k.id, k.order]);
  for (const k of [['adjustment', 200], ['fill', 300], ['shape', 350]]) assert.ok(kinds.some(([id, o]) => id === k[0] && o === k[1]), k[0]);
  const aspects = R.psdAspects().map((a) => [a.id, a.order, a.builtin]);
  for (const [id, order] of [['advanced-blending', 210], ['vector-mask', 290], ['raster-mask', 300], ['effects', 400], ['tags', 500]]) {
    const a = aspects.find((x) => x[0] === id);
    assert.ok(a && a[1] === order, id);
    assert.equal(a[2], false, `${id} is psd-layers' registration, not a builtin`);
  }
  assert.ok(R.psdResources().some((r) => r.id === 'global-light' && r.order === 250));
});

test('paths: Pigment PathData and ag-psd path records both ways (handles, operations, open paths, linked knots)', () => {
  const path = {
    subpaths: [
      { closed: true, points: [{ x: 10, y: 10, outX: 30, outY: 5 }, { x: 50, y: 10, inX: 40, inY: 5, outX: 60, outY: 15 }, { x: 50, y: 40 }, { x: 10, y: 40 }] },
      { closed: true, op: 'subtract', points: [{ x: 20, y: 20 }, { x: 30, y: 20 }, { x: 30, y: 30 }] },
      { closed: false, op: 'exclude', points: [{ x: 0, y: 70 }, { x: 90, y: 75 }] },
    ],
  };
  const recs = V.pathToPsd(path, 100, 80);
  assert.equal(recs.length, 3);
  assert.deepEqual(recs.map((r) => [r.open, r.operation]), [[false, 'combine'], [false, 'subtract'], [true, 'exclude']]);
  // the smooth point's handles are collinear: linked; a corner is not
  assert.equal(recs[0].knots[1].linked, true);
  assert.equal(recs[0].knots[2].linked, false);
  assert.deepEqual(recs[0].knots[1].points, [40, 5, 50, 10, 60, 15]);
  // through the file (vmsk, 8.24 fixed point of the document size)
  const back = viaFile([{ name: 'L', vectorMask: { paths: recs } }]).children[0];
  const again = V.pathFromPsd(back.vectorMask.paths, 100, 80);
  assert.deepEqual(again, path);
  assert.equal(V.pathFromPsd([], 1, 1), null);
  assert.equal(V.pathToPsd({ subpaths: [] }, 1, 1), null);
});

test('effects: every effect and instance goes through lfx2 / lmfx and comes back with Pigment\'s values', () => {
  const contour = { name: 'Cone', points: [{ x: 0, y: 0, corner: false }, { x: 128 / 255, y: 1, corner: true }, { x: 1, y: 0, corner: false }] };
  const styles = {
    dropShadow: [{ enabled: true, blend: 'multiply', color: '#102030', opacity: 0.6, angle: 135, useGlobalLight: true, distance: 7, spread: 3, size: 9, contour, antiAlias: true, noise: 0.25, knocksOut: false }, { enabled: false, blend: 'normal', color: '#ff0000', opacity: 1, angle: 30, distance: 2, spread: 0, size: 1 }],
    innerShadow: { enabled: true, blend: 'multiply', color: '#000000', opacity: 0.75, angle: 120, distance: 4, spread: 1, size: 3 },
    outerGlow: { enabled: true, blend: 'screen', opacity: 0.8, technique: 'precise', spread: 2, size: 8, range: 0.4, jitter: 0.1, noise: 0.05, fill: 'gradient', gradient: { gradientVersion: 2, type: 'solid', interpolation: 'classic', smoothness: 1, stops: [{ pos: 0, mid: 0.5, color: '#ffff00' }, { pos: 1, mid: 0.5, color: '#ff0000' }], opacityStops: [{ pos: 0, mid: 0.5, opacity: 1 }, { pos: 1, mid: 0.5, opacity: 0 }] } },
    innerGlow: { enabled: true, blend: 'screen', color: '#ffffbe', opacity: 0.75, source: 'center', choke: 4, size: 4, technique: 'softer' },
    bevel: { enabled: true, style: 'pillow-emboss', technique: 'chisel-soft', depth: 250, direction: 'down', size: 6, soften: 2, angle: 100, altitude: 45, useGlobalLight: false, highlightColor: '#ffffee', highlightOpacity: 0.5, highlightBlend: 'screen', shadowColor: '#000022', shadowOpacity: 0.6, shadowBlend: 'multiply', glossContour: contour, antiAlias: true, contourSub: { enabled: true, contour: null, antiAlias: true, range: 0.3 } },
    satin: { enabled: true, blend: 'multiply', color: '#000000', opacity: 0.5, angle: 19, distance: 11, size: 14, invert: false, contour, antiAlias: false },
    colorOverlay: [{ enabled: true, blend: 'color', color: '#00ff00', opacity: 0.3 }, { enabled: true, blend: 'normal', color: '#0000ff', opacity: 0.1 }],
    gradientOverlay: { enabled: true, blend: 'overlay', opacity: 0.5, kind: 'radial', angle: 45, scale: 1.5, offset: [10, -5], align: false, reverse: true, dither: true, gradient: { gradientVersion: 2, type: 'solid', interpolation: 'perceptual', smoothness: 0.8, stops: [{ pos: 0, mid: 0.5, color: '#ff0000' }, { pos: 1, mid: 0.4, color: '#0000ff' }], opacityStops: [{ pos: 0, mid: 0.5, opacity: 1 }, { pos: 1, mid: 0.5, opacity: 0.5 }] } },
    stroke: [{ enabled: true, size: 4, position: 'center', blend: 'normal', opacity: 1, fill: 'gradient', kind: 'shape-burst', angle: 90, scale: 1, gradient: { stops: [{ pos: 0, color: '#000000' }, { pos: 1, color: '#ffffff' }] } }, { enabled: true, size: 2, position: 'inside', blend: 'multiply', opacity: 0.5, color: '#00ff00', fill: 'color' }],
  };
  const w = E.stylesToPsd(styles);
  assert.deepEqual(w.report, []);
  assert.equal(w.effects.dropShadow.length, 2);
  // Photoshop's spread is a percentage of the size: 3 px hard edge + 9 px blur = 12 px at 25 %
  assert.deepEqual(w.effects.dropShadow[0].size, { units: 'Pixels', value: 12 });
  assert.ok(near(w.effects.dropShadow[0].choke.value, 25));
  const pl = viaFile([{ name: 'L', effects: w.effects, effectsExtra: w.extra }]).children[0];
  assert.ok(pl.effectsDescriptor, 'the raw descriptor is kept');
  const { styles: back, report } = E.stylesFromPsd(pl.effects, { descriptor: pl.effectsDescriptor });
  assert.deepEqual(report, []);
  const ds = back.dropShadow[0];
  assert.deepEqual({ ...ds, spread: Math.round(ds.spread * 1000) / 1000, size: Math.round(ds.size * 1000) / 1000 }, styles.dropShadow[0]);
  assert.equal(back.dropShadow[1].enabled, false);
  assert.equal(back.innerShadow.spread, 1);
  assert.equal(back.outerGlow.fill, 'gradient');
  assert.equal(back.outerGlow.technique, 'precise');
  assert.equal(back.outerGlow.gradient.opacityStops[1].opacity, 0);
  assert.equal(back.innerGlow.source, 'center');
  assert.equal(back.innerGlow.choke, 4);
  assert.deepEqual(back.bevel, styles.bevel);
  assert.deepEqual(back.satin, styles.satin);
  assert.deepEqual(back.colorOverlay, styles.colorOverlay);
  const go = back.gradientOverlay;
  assert.deepEqual({ kind: go.kind, angle: go.angle, scale: go.scale, offset: go.offset, align: go.align, reverse: go.reverse, dither: go.dither, blend: go.blend }, { kind: 'radial', angle: 45, scale: 1.5, offset: [10, -5], align: false, reverse: true, dither: true, blend: 'overlay' });
  assert.equal(go.gradient.interpolation, 'perceptual');
  assert.ok(near(go.gradient.smoothness, 0.8, 1e-3));
  assert.deepEqual(go.gradient.stops.map((s) => [s.pos, s.mid, s.color]), [[0, 0.5, '#ff0000'], [1, 0.4, '#0000ff']]);
  assert.deepEqual(go.stops, [{ pos: 0, color: '#ff0000' }, { pos: 1, color: '#0000ff' }]);
  assert.equal(back.stroke.length, 2);
  assert.equal(back.stroke[0].kind, 'shape-burst');
  assert.equal(back.stroke[0].fill, 'gradient');
  assert.equal(back.stroke[1].color, '#00ff00');
  assert.equal(back.stroke[1].position, 'inside');
});

test('effects: Hide All Effects, the effects scale, what Pigment lacks (reported by name) and a colour with alpha', () => {
  const w = E.stylesToPsd({ hidden: true, stroke: { enabled: true, size: 3, color: '#ff000080' } });
  assert.equal(w.effects.disabled, true);
  assert.ok(near(w.effects.stroke[0].opacity, 128 / 255, 1e-3), 'the colour\'s alpha goes into the opacity');
  const back = E.stylesFromPsd(viaFile([{ name: 'L', effects: w.effects, effectsExtra: w.extra }]).children[0].effects).styles;
  assert.equal(back.hidden, true);
  // Photoshop's effects scale: Pigment stores scaled values
  const scaled = E.stylesFromPsd({ scale: 2, dropShadow: [{ enabled: true, size: { units: 'Pixels', value: 5 }, distance: { units: 'Pixels', value: 4 }, choke: { units: 'Pixels', value: 0 } }] }).styles;
  assert.equal(scaled.dropShadow.size, 10);
  assert.equal(scaled.dropShadow.distance, 8);
  const { styles, report } = E.stylesFromPsd({ bevel: { enabled: true, style: 'stroke emboss' }, stroke: [{ enabled: true, overprint: true, size: { units: 'Pixels', value: 2 } }], patternOverlay: { enabled: true, pattern: { name: 'Gone', id: 'nope' } } });
  assert.equal(styles.bevel.style, 'emboss');
  assert.equal(styles.patternOverlay.enabled, false);
  assert.deepEqual(report, ['Bevel & Emboss (Stroke Emboss, read as Emboss)', 'Pattern Overlay (pattern Gone)', 'Stroke (Overprint)']);
  // the open notice counts them by name
  const r = createReport();
  for (const x of report) r.add('psd-effects', x);
  assert.match(r.lines('open')[0], /^3 layer effect settings Pigment does not have were approximated or dropped: Bevel & Emboss/);
  assert.deepEqual(E.stylesToPsd(null), { effects: null, patterns: [], report: [], extra: {} });
  assert.equal(E.stylesFromPsd(null).styles, null);
});

test('effects: a Stripes gradient is saved as Classic and said; a pattern effect carries the pattern', () => {
  const w = E.stylesToPsd({ gradientOverlay: { enabled: true, gradient: { gradientVersion: 2, type: 'solid', interpolation: 'stripes', smoothness: 1, stops: [{ pos: 0, mid: 0.5, color: '#000000' }, { pos: 1, mid: 0.5, color: '#ffffff' }], opacityStops: [{ pos: 0, mid: 0.5, opacity: 1 }, { pos: 1, mid: 0.5, opacity: 1 }] } } });
  assert.equal(w.effects.gradientOverlay[0].interpolationMethod, 'classic');
  assert.deepEqual(w.report, ['Gradient Overlay (Stripes gradient method (saved as Classic))']);
  const pattern = { width: 2, height: 1, data: new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 255, 255]) };
  const p = E.stylesToPsd({ patternOverlay: { enabled: true, pattern, scale: 2, angle: 30, link: false, origin: [3, 4] } });
  assert.equal(p.patterns.length, 1);
  assert.equal(p.effects.patternOverlay.pattern.id, p.patterns[0].id);
  const pl = viaFile([{ name: 'L', effects: p.effects, effectsExtra: p.extra }], { patterns: p.patterns }).children[0];
  assert.equal(pl.effectsDescriptor.patternFill.Angl.value, 30, 'Photoshop\'s key for the angle');
  assert.equal(pl.effects.patternOverlay.scale, 2);
  assert.deepEqual(pl.effects.patternOverlay.phase, { x: 3, y: 4 });
  assert.equal(pl.effects.patternOverlay.align, false);
  // an unloaded pattern is said, and the effect is not written
  const missing = E.stylesToPsd({ patternOverlay: { enabled: true, pattern: { dataUrl: 'data:image/png;base64,AAAA', name: 'Later' } } });
  assert.equal(missing.effects, null);
  assert.deepEqual(missing.report, ['Pattern Overlay (pattern not loaded)']);
});

test('advanced blending: every Blending Options field both ways, through knko, brst, clbl, infx, tsly, lmgm and vmgm', () => {
  const blending = { knockout: 'deep', interiorAsGroup: true, clippedAsGroup: false, transparencyShapes: false, maskHidesEffects: true, vectorMaskHidesEffects: true, channels: { r: true, g: false, b: true } };
  const rec = E.advancedBlendingToPsd(blending);
  assert.equal(rec.knockoutMode, 'deep');
  assert.deepEqual(rec.channelBlendingRestrictions, [1]);
  const pl = viaFile([{ name: 'L', ...rec }]).children[0];
  assert.equal(pl.knockoutMode, 'deep');
  assert.deepEqual(pl.channelBlendingRestrictions, [1], 'one restricted channel reads (ag-psd read none)');
  assert.equal(pl.vectorMaskAsGlobalMask, true);
  assert.deepEqual(E.advancedBlendingFromPsd(pl), blending);
  // shallow, and two channels
  const two = viaFile([{ name: 'L', ...E.advancedBlendingToPsd({ knockout: 'shallow', channels: { r: false, g: true, b: false } }) }]).children[0];
  assert.deepEqual(E.advancedBlendingFromPsd(two), { knockout: 'shallow', channels: { r: false, g: true, b: false } });
  // defaults (and Blend If alone, the built-in's) write nothing
  assert.equal(E.advancedBlendingToPsd(null), null);
  assert.equal(E.advancedBlendingToPsd({ blendIf: { gray: { this: [0, 0, 200, 255], under: [0, 0, 255, 255] } } }), null);
  assert.deepEqual(E.advancedBlendingFromPsd({}), {});
});

test('the aspects claim what they write, so the built-in notice stays only where nobody claimed (mode documents)', () => {
  const effects = R.psdAspects().find((a) => a.id === 'effects');
  const advanced = R.psdAspects().find((a) => a.id === 'advanced-blending');
  const run = (layer, { modeRendered = false, asShown = () => true } = {}) => {
    const claims = new Set();
    const rec = {};
    const ctx = { doc: { layers: () => [layer] }, psd: {}, report: createReport(), modeRendered, asShown, claim: (l, p) => claims.add(p), claimed: (l, p) => claims.has(p) };
    effects.write(layer, rec, ctx);
    advanced.write(layer, rec, ctx);
    return { claims: [...claims].sort(), rec };
  };
  const red = { type: 'raster', styles: { colorOverlay: { enabled: true, color: '#ff0000' } }, blending: { knockout: 'deep', channels: { r: false } } };
  assert.deepEqual(run(red).claims, ['advanced-blending', 'effects']);
  // Grayscale: a red overlay is not what the document shows, and a channel restriction would colour the greys
  const grey = run(red, { modeRendered: true, asShown: (hex) => hex === '#808080' });
  assert.deepEqual(grey.claims, []);
  assert.equal(grey.rec.effects, undefined);
  const greyOk = run({ type: 'raster', styles: { colorOverlay: { enabled: true, color: '#808080' } }, blending: { knockout: 'deep' } }, { modeRendered: true, asShown: (hex) => hex === '#808080' });
  assert.deepEqual(greyOk.claims, ['advanced-blending', 'effects']);
});

test('adjustments: Colorize and Color Lookup stay editable; the colorized notice is gone', async () => {
  const p = { hue: 10, saturation: -5, lightness: 3, colorize: true, colorizeHue: 200, colorizeSat: 40, colorizeLight: -10, ranges: [] };
  const a = A.adjustmentToPsd('hue-saturation', p);
  const back = viaFile([{ name: 'H', adjustment: a }]).children[0].adjustment;
  assert.deepEqual(A.adjustmentFromPsd(back).params, { hue: 10, saturation: -5, lightness: 3, colorize: true, colorizeHue: 200, colorizeSat: 40, colorizeLight: -10, range: 'master', ranges: [] });
  assert.equal(A.adjustmentFromPsd(back).params.hue, 10);
  // a file of 0.4 (no colorize) reads as before
  assert.equal(A.adjustmentFromPsd(viaFile([{ name: 'H', adjustment: A.adjustmentToPsd('hue-saturation', { hue: 5 }) }]).children[0].adjustment).params.colorize, false);
  const kind = R.psdLayerKinds().find((k) => k.id === 'adjustment');
  const report = createReport();
  kind.write({ type: 'adjustment', kind: 'hue-saturation', params: p }, { report, claim() {} });
  assert.equal(report.count('colorized'), 0);
  // Color Lookup: a built-in look by name, a loaded table as .cube data
  const { LUT_PRESET_NAMES, makeLut3d } = await import('../../src/shared/pixels/lut.js');
  const preset = LUT_PRESET_NAMES[0];
  const named = A.adjustmentFromPsd(viaFile([{ name: 'C', adjustment: A.adjustmentToPsd('color-lookup', { preset, lut: null, dither: true }) }]).children[0].adjustment);
  assert.deepEqual(named, { kind: 'color-lookup', params: { preset, lut: null, dither: true } });
  const lut = makeLut3d(5, (r, g, b) => [1 - r, g, b * 0.5], 'Swap');
  const custom = A.adjustmentFromPsd(viaFile([{ name: 'C', adjustment: A.adjustmentToPsd('color-lookup', { preset: 'none', lut, dither: false }) }]).children[0].adjustment);
  assert.equal(custom.kind, 'color-lookup');
  assert.equal(custom.params.lut.size, 5);
  for (let i = 0; i < lut.data.length; i++) assert.ok(near(custom.params.lut.data[i], lut.data[i], 1e-5));
  // an ICC abstract profile has no Pigment form: the 0.4 placeholder
  assert.equal(A.adjustmentFromPsd({ type: 'color lookup', lookupType: 'abstractProfile', name: 'x' }), null);
});

test('fill and shape paints: solid, gradient (the Gradient Fill placement), noise gradient, and what cannot be written', () => {
  assert.deepEqual(P.paintFromContent(P.paintToContent({ type: 'solid', color: '#123456' }).content), { type: 'solid', color: '#123456' });
  // a fill layer's from / to become angle, scale and offset over the document, and come back
  const paint = { type: 'gradient', gradient: { kind: 'linear', from: [20, 30], to: [150, 100], reverse: true, stops: [{ pos: 0, color: '#ffffff' }, { pos: 1, color: '#000000' }] } };
  const { content } = P.paintToContent(paint, { place: 'document', width: 200, height: 150 });
  assert.equal(content.style, 'linear');
  assert.equal(content.reverse, true);
  const pl = viaFile([{ name: 'F', vectorFill: content }]).children[0];
  const back = P.paintFromContent(pl.vectorFill, { place: 'document', width: 200, height: 150 });
  for (let i = 0; i < 2; i++) {
    assert.ok(near(back.gradient.from[i], paint.gradient.from[i], 0.01), `from ${i}`);
    assert.ok(near(back.gradient.to[i], paint.gradient.to[i], 0.01), `to ${i}`);
  }
  // a shape's gradient keeps its box placement
  const shape = P.paintFromContent(P.paintToContent({ type: 'gradient', gradient: { kind: 'radial', angle: 30, scale: 0.5, offset: [10, 20], stops: [{ pos: 0, color: '#ff0000' }, { pos: 1, color: '#0000ff' }] } }, { place: 'box' }).content, { place: 'box' });
  assert.deepEqual({ kind: shape.gradient.kind, angle: shape.gradient.angle, scale: shape.gradient.scale, offset: shape.gradient.offset }, { kind: 'radial', angle: 30, scale: 0.5, offset: [10, 20] });
  // a noise gradient goes both ways
  const noise = normalizeGradient({ gradientVersion: 2, type: 'noise', noise: { roughness: 0.7, model: 'hsb', min: [0, 0.2, 0], max: [1, 1, 0.9], restrict: true, transparency: false, seed: 42 } });
  const n = P.gradientDefFromPsd(P.gradientDefToPsd(noise).gradient);
  assert.deepEqual(n.noise, noise.noise);
  // the colours of the solid def come back with their LUT (classic, smoothness 0 is 0.3's)
  const def = normalizeGradient({ stops: [{ pos: 0, color: '#000000' }, { pos: 0.3, color: '#ff8000' }, { pos: 1, color: '#ffffff' }] });
  const def2 = P.gradientDefFromPsd(P.gradientDefToPsd(def).gradient);
  const l1 = gradientLut(def, { size: 64 }), l2 = gradientLut(def2, { size: 64 });
  for (let i = 0; i < l1.length; i++) assert.ok(Math.abs(l1[i] - l2[i]) <= 1, `lut ${i}`);
  // a pattern with no pixels at hand cannot be written; one the file lacks cannot be read
  assert.equal(P.paintToContent({ type: 'pattern', pattern: { dataUrl: 'data:,', name: 'P' } }).content, null);
  assert.equal(P.paintFromContent({ type: 'pattern', name: 'P', id: 'missing' }, { patterns: new Map() }), null);
  // pattern fills keep Scale, Angle and Link with Layer through PtFl (ag-psd drops the first two and cannot write the third)
  const pat = viaFile([{ name: 'P', vectorFill: { type: 'pattern', name: 'P', id: 'abc', scale: 2.5, angle: 45, linked: false, phase: { x: 2, y: 3 } } }]).children[0].vectorFill;
  assert.deepEqual(pat, { type: 'pattern', name: 'P', id: 'abc', linked: false, phase: { x: 2, y: 3 }, scale: 2.5, angle: 45 });
});

test('tags and the global light: labels, link groups (two members or more) and the global angle', () => {
  const tags = R.psdAspects().find((a) => a.id === 'tags');
  const layers = [{ color: 'violet', linked: 'K1' }, { color: null, linked: 'K1' }, { color: 'none', linked: 'K2' }, {}];
  const doc = { layers: () => layers };
  const psd = {};
  const recs = layers.map((l) => {
    const rec = {};
    tags.write(l, rec, { doc, psd, claim() {} });
    return rec;
  });
  assert.deepEqual(recs, [{ layerColor: 'violet', linkGroup: 1, linkGroupEnabled: true }, { linkGroup: 1, linkGroupEnabled: true }, {}, {}]);
  // ag-psd puts link groups in image resources 1026 / 1072 and reads them back onto the layers
  const back = viaFile(recs.map((r, i) => ({ name: `L${i}`, ...r })));
  assert.deepEqual(back.children.map((c) => [c.layerColor, c.linkGroup]), [['violet', 1], [undefined, 1], [undefined, 0], [undefined, 0]]);
  const read = [{}, {}, {}, {}];
  const rdoc = { layers: () => read };
  back.children.forEach((pl, i) => tags.read(pl, read[i], { doc: rdoc, claim() {} }));
  R.psdResources().find((r) => r.id === 'link-groups').read({}, rdoc, {});
  assert.equal(read[0].color, 'violet');
  assert.ok(read[0].linked && read[0].linked === read[1].linked);
  assert.equal(read[2].linked, undefined);
  // global light: written when set (or when a layer has effects), read back when it is not Photoshop's default
  const light = R.psdResources().find((r) => r.id === 'global-light');
  const out = { imageResources: {} };
  light.write({ globalLight: { angle: 60, altitude: 40 }, layers: () => [] }, out, {});
  assert.deepEqual([out.imageResources.globalAngle, out.imageResources.globalAltitude], [60, 40]);
  const none = {};
  light.write({ globalLight: null, layers: () => [{ styles: null }] }, none, {});
  assert.equal(none.imageResources, undefined, 'nothing to say: 0.4\'s file');
  const d = {};
  light.read(viaFile([{ name: 'L' }], { imageResources: { globalAngle: 75, globalAltitude: 20 } }), d, {});
  assert.deepEqual(d.globalLight, { angle: 75, altitude: 20 });
  const d2 = {};
  light.read({ imageResources: { globalAngle: 120, globalAltitude: 30 } }, d2, {});
  assert.equal(d2.globalLight, undefined);
});

test('the save option asks only with the preference "ask"; the Preferences section reads and writes settings.psd', async () => {
  const F = await import('../../src/renderer/lib/psd/file-handling.js');
  const app = { settings: { psd: { maximizeCompatibility: 'always' } } };
  assert.deepEqual(await F.askMaximizeCompatibility(app, {}, 'x.psd', { ask: true }), {});
  app.settings.psd.maximizeCompatibility = 'ask';
  assert.deepEqual(await F.askMaximizeCompatibility(app, {}, 'x.psd', { ask: false }), { maximizeCompatibility: true });
  const sec = F.fileHandlingSection();
  assert.equal(sec.id, 'file-handling');
  assert.equal(sec.order, 45);
  assert.deepEqual(sec.read({ psd: { maximizeCompatibility: 'never' } }), { psdMaximize: 'never' });
  assert.deepEqual(sec.read({}), { psdMaximize: 'always' });
  assert.deepEqual(sec.write({ psdMaximize: 'ask' }, { psd: { maximizeCompatibility: 'always', other: 1 } }), { psd: { maximizeCompatibility: 'ask', other: 1 } });
  assert.deepEqual(sec.write({ psdMaximize: 'always' }, { psd: { maximizeCompatibility: 'always' } }), {});
});
