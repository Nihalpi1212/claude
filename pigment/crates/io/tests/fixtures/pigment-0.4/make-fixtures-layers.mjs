// The documents with adjustment, fill and shape layers, vector masks, layer styles and advanced
// blending. make-fixtures.mjs calls this file; README.md says how to run it.
//
// Every document is written twice: `<name>.pigment` by the app's writer, and `<name>.png`, the
// picture the app's own compositor makes of it (`flattenDocument` in src/renderer/lib/compositor.js),
// which the importer's tests compare with the picture of the opened document.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

export default async function layerFixtures({ set, lib, out, io, D, add, canvasFrom, background, save }) {
  const { Document, RasterLayer, GroupLayer, ShapeLayer, FillLayer, AdjustmentLayer, createCanvas } = D;
  const { flattenDocument } = await lib('renderer/lib/compositor.js');
  const v3 = set === 'v3';

  /** Writes the document and the app's picture of it. */
  async function saveBoth(name, doc) {
    await save(`${set}-${name}`, doc);
    writeFileSync(join(out, `${set}-${name}.png`), await io.canvasToPng(flattenDocument(doc)));
  }

  // ---- pixels the tests know -------------------------------------------------------------------

  const hsv = (h, s, v) => {
    const f = (n) => {
      const k = (n + h / 60) % 6;
      return Math.round(255 * (v - v * s * Math.max(0, Math.min(k, 4 - k, 1))));
    };
    return [f(5), f(3), f(1)];
  };
  /** A photograph's worth of colours in 24 x 24: hues across, less saturation and value down, and a grey ramp. */
  const SIZE = 24;
  const photoPixel = (x, y) => (y >= 20 ? [x * 11, x * 11, x * 11, 255] : [...hsv(x * 15, 1 - (y % 5) * 0.2, 1 - Math.floor(y / 5) * 0.25), 255]);
  function photo(name) {
    const doc = new Document({ width: SIZE, height: SIZE, name });
    add(doc.root, new RasterLayer({ name: 'Background', canvas: canvasFrom(SIZE, SIZE, photoPixel), x: 0, y: 0 }));
    return doc;
  }
  /** A white document with a mid-grey disc, soft at its edge: what the layer styles are applied to. */
  function disc(doc, name, props = {}) {
    const w = 20, h = 20;
    const c = createCanvas(w, h);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#6080a0';
    ctx.beginPath();
    ctx.arc(10, 10, 8, 0, Math.PI * 2);
    ctx.fill();
    return add(doc.root, new RasterLayer({ name, canvas: c, x: 6, y: 6, ...props }));
  }
  function styled(name, styles, props = {}) {
    const doc = new Document({ width: 32, height: 32, name });
    background(doc);
    disc(doc, 'Styled', props).styles = styles;
    return doc;
  }
  /** A 4 x 4 pattern tile: a red, a green, a blue and a yellow quarter. */
  const tile = () => canvasFrom(4, 4, (x, y) => (y < 2 ? (x < 2 ? [255, 0, 0, 255] : [0, 255, 0, 255]) : x < 2 ? [0, 0, 255, 255] : [255, 255, 0, 255]));

  // ---- adjustment layers -----------------------------------------------------------------------

  async function adjustment(name, kind, params, props = {}) {
    const doc = photo(`Adjustment ${name}`);
    add(doc.root, new AdjustmentLayer({ name: 'Adjustment', kind, params, ...props }));
    await saveBoth(`adjust-${name}`, doc);
  }

  const table = Array.from({ length: 256 }, (_, v) => (v < 128 ? Math.round(v * 1.5) : 255 - Math.round((v - 128) * 0.25)));
  await adjustment('brightness-contrast', 'brightness-contrast', { brightness: 40, contrast: -30, legacy: false });
  await adjustment('brightness-contrast-legacy', 'brightness-contrast', { brightness: -25, contrast: 35, legacy: true });
  await adjustment('levels', 'levels', {
    perChannel: true,
    rgb: { inBlack: 20, inWhite: 230, gamma: 1.4, outBlack: 10, outWhite: 240 },
    r: { inBlack: 0, inWhite: 255, gamma: 0.8, outBlack: 0, outWhite: 255 },
    g: null,
    b: { inBlack: 30, inWhite: 200, gamma: 1, outBlack: 0, outWhite: 220 },
  });
  // 0.3's flag: the channel tables are there and are not used
  await adjustment('levels-composite-only', 'levels', { perChannel: false, rgb: { inBlack: 40, inWhite: 210, gamma: 0.7, outBlack: 0, outWhite: 255 }, r: { inBlack: 100, inWhite: 150, gamma: 1, outBlack: 0, outWhite: 255 }, g: null, b: null });
  await adjustment('curves', 'curves', { rgb: [[0, 0], [64, 40], [192, 220], [255, 255]], r: [[0, 20], [255, 235]], g: null, b: [[0, 0], [128, 90], [255, 255]] });
  await adjustment('exposure', 'exposure', { exposure: 0.8, offset: -0.05, gamma: 1.2 });
  await adjustment('vibrance', 'vibrance', { vibrance: 60, saturation: -20 });
  await adjustment('hue-saturation', 'hue-saturation', { hue: 40, saturation: 20, lightness: -10, colorize: false });
  await adjustment('hue-saturation-colorize', 'hue-saturation', { hue: 0, saturation: 0, lightness: 0, colorize: true, colorizeHue: 210, colorizeSat: 50, colorizeLight: -10 });
  // 0.3's one colour range: `range` names it and the values are the top-level ones
  await adjustment('hue-saturation-one-range', 'hue-saturation', { hue: -60, saturation: 30, lightness: 0, colorize: false, range: 'greens' });
  await adjustment('color-balance', 'color-balance', { shadows: [20, -10, 5], midtones: [-30, 0, 40], highlights: [0, 15, -25], preserveLuminosity: true });
  await adjustment('color-balance-no-luminosity', 'color-balance', { shadows: [0, 0, 0], midtones: [50, -20, 0], highlights: [0, 0, 0], preserveLuminosity: false });
  await adjustment('black-white', 'black-white', { reds: 80, yellows: 10, greens: 120, cyans: -50, blues: 200, magentas: 30, tint: null });
  await adjustment('black-white-tint', 'black-white', { reds: 40, yellows: 60, greens: 40, cyans: 60, blues: 20, magentas: 80, tint: { hue: 30, sat: 40 } });
  await adjustment('photo-filter', 'photo-filter', { color: '#00a0ff', density: 60, preserveLuminosity: true });
  await adjustment('photo-filter-no-luminosity', 'photo-filter', { color: '#ec8a00', density: 40, preserveLuminosity: false });
  await adjustment('channel-mixer', 'channel-mixer', { r: { r: 80, g: 30, b: -10, constant: 5 }, g: { r: 0, g: 110, b: 0, constant: -4 }, b: { r: 20, g: 20, b: 60, constant: 0 }, gray: { r: 40, g: 40, b: 20, constant: 0 }, monochrome: false });
  await adjustment('channel-mixer-monochrome', 'channel-mixer', { r: { r: 100, g: 0, b: 0, constant: 0 }, g: { r: 0, g: 100, b: 0, constant: 0 }, b: { r: 0, g: 0, b: 100, constant: 0 }, gray: { r: 30, g: 60, b: 10, constant: -5 }, monochrome: true });
  await adjustment('invert', 'invert', {});
  await adjustment('posterize', 'posterize', { levels: 5 });
  await adjustment('threshold', 'threshold', { level: 100 });
  await adjustment('gradient-map', 'gradient-map', { stops: [{ offset: 0, color: '#200040' }, { offset: 0.6, color: '#ff8000' }, { offset: 1, color: '#ffffc0' }], reverse: false, dither: false });
  await adjustment('gradient-map-reverse', 'gradient-map', { stops: [{ offset: 0, color: '#000000' }, { offset: 1, color: '#00ff80' }], reverse: true, dither: false });
  await adjustment('selective-color', 'selective-color', {
    reds: { c: -50, m: 20, y: 0, k: 10 }, yellows: { c: 0, m: 0, y: -60, k: 0 }, greens: { c: 40, m: 0, y: 0, k: 0 }, cyans: { c: 0, m: 0, y: 0, k: 0 },
    blues: { c: 0, m: -30, y: 30, k: 0 }, magentas: { c: 0, m: 0, y: 0, k: 0 }, whites: { c: 0, m: 0, y: 20, k: 0 }, neutrals: { c: 10, m: 0, y: 0, k: -10 }, blacks: { c: 0, m: 0, y: 0, k: 15 },
    relative: false,
  });
  await adjustment('selective-color-relative', 'selective-color', {
    reds: { c: 60, m: 0, y: 0, k: 0 }, yellows: { c: 0, m: 0, y: 0, k: 0 }, greens: { c: 0, m: 50, y: 0, k: 0 }, cyans: { c: 0, m: 0, y: 0, k: 0 },
    blues: { c: 0, m: 0, y: 0, k: 0 }, magentas: { c: 0, m: 0, y: 0, k: 0 }, whites: { c: 0, m: 0, y: 0, k: 0 }, neutrals: { c: 0, m: 0, y: 0, k: 0 }, blacks: { c: 0, m: 0, y: 0, k: 0 },
    relative: true,
  });
  // the layer properties an adjustment layer shares with the others, and a mask over half of it
  {
    const doc = photo('Adjustment with a mask');
    const layer = add(doc.root, new AdjustmentLayer({ name: 'Adjustment', kind: 'invert', params: {}, opacity: 0.5, blend: 'luminosity' }));
    layer.mask = { canvas: canvasFrom(SIZE, SIZE, (x) => (x < 12 ? [255, 255, 255, 255] : [0, 0, 0, 255])), enabled: true, linked: true };
    await saveBoth('adjust-masked', doc);
  }
  if (v3) {
    await adjustment('curves-pencil', 'curves', { rgb: { table }, r: null, g: [[0, 0], [100, 160], [255, 255]], b: null });
    await adjustment('hue-saturation-ranges', 'hue-saturation', {
      hue: 10, saturation: 0, lightness: 0, colorize: false,
      ranges: [{ base: 'reds', bounds: [315, 345, 15, 45], hue: -60, saturation: 20, lightness: 0 }, { base: 'blues', bounds: [200, 230, 260, 290], hue: 0, saturation: -80, lightness: 10 }],
    });
    // 0.4's gradient: a midpoint and a perceptual blend
    await adjustment('gradient-map-v2', 'gradient-map', {
      gradientVersion: 2, type: 'solid', interpolation: 'perceptual', smoothness: 1,
      stops: [{ pos: 0, mid: 0.5, color: '#001060' }, { pos: 0.5, mid: 0.3, color: '#e02020' }, { pos: 1, mid: 0.5, color: '#fff0a0' }],
      opacityStops: [{ pos: 0, mid: 0.5, opacity: 1 }, { pos: 1, mid: 0.5, opacity: 1 }],
      reverse: false, dither: false,
    });
    await adjustment('color-lookup-preset', 'color-lookup', { preset: 'Teal Orange', lut: null, dither: false });
    const { makeLut3d, compactLut } = await lib('shared/pixels/lut.js');
    await adjustment('color-lookup-table', 'color-lookup', { preset: 'none', lut: compactLut(makeLut3d(5, (r, g, b) => [g, b * 0.8, 1 - r], 'Swapped')), dither: false });
    // the channel spaces of Levels and Curves
    await adjustment('levels-gray', 'levels', { space: 'gray', gray: { inBlack: 30, inWhite: 220, gamma: 1.3, outBlack: 0, outWhite: 255 } });
    await adjustment('curves-lab', 'curves', { space: 'lab', l: [[0, 0], [128, 160], [255, 255]], a: null, b: [[0, 30], [255, 225]] });
    await adjustment('levels-cmyk', 'levels', { space: 'cmyk', cmyk: { inBlack: 10, inWhite: 245, gamma: 1.1, outBlack: 0, outWhite: 255 }, c: { inBlack: 0, inWhite: 255, gamma: 1.5, outBlack: 0, outWhite: 255 }, m: null, y: null, k: { inBlack: 20, inWhite: 255, gamma: 1, outBlack: 0, outWhite: 255 } });
    // the kinds Pigment 0.4 added, which have no counterpart yet
    await adjustment('color-vibrance', 'color-vibrance', { temperature: 30, tint: -10, vibrance: 40, saturation: 10 });
    await adjustment('clarity-dehaze', 'clarity-dehaze', { clarity: 50, dehaze: 20 });
    await adjustment('grain', 'grain', { amount: 40, size: 25, roughness: 50 });
  }

  // ---- fill layers -----------------------------------------------------------------------------

  async function fill(name, paint, props = {}, size = [32, 24]) {
    const doc = new Document({ width: size[0], height: size[1], name: `Fill ${name}` });
    background(doc);
    add(doc.root, new FillLayer({ name: 'Fill', paint, docWidth: doc.width, docHeight: doc.height, ...props }));
    await saveBoth(`fill-${name}`, doc);
  }
  const stops03 = [{ pos: 0, color: '#ff0000' }, { pos: 0.4, color: '#ffff00' }, { pos: 1, color: '#0000ff' }];
  await fill('solid', { type: 'solid', color: '#3366cc' }, { opacity: 0.75 });
  // 0.3's gradients: the stops as they are, from one point to another (document pixels)
  await fill('gradient-linear', { type: 'gradient', gradient: { kind: 'linear', stops: stops03, from: [4, 4], to: [28, 20], reverse: false } });
  await fill('gradient-radial', { type: 'gradient', gradient: { kind: 'radial', stops: stops03, from: [12, 10], to: [28, 10], reverse: false } });
  await fill('gradient-angle', { type: 'gradient', gradient: { kind: 'angle', stops: stops03, from: [16, 12], to: [16, 2], reverse: false } });
  await fill('gradient-reflected', { type: 'gradient', gradient: { kind: 'reflected', stops: stops03, from: [16, 12], to: [26, 12], reverse: true } });
  await fill('gradient-diamond', { type: 'gradient', gradient: { kind: 'diamond', stops: stops03, from: [16, 12], to: [28, 16], reverse: false } });
  // stops with their own transparency, and no end points: left to right across the document
  await fill('gradient-plain', { type: 'gradient', gradient: { kind: 'linear', stops: [{ pos: 0, color: '#00ff0000' }, { pos: 1, color: '#00ff00ff' }] } });
  // 0.3's pattern fill: the tile from the document origin, scaled
  await fill('pattern', { type: 'pattern', pattern: { canvas: tile(), scale: 2 } });
  if (v3) {
    const def = {
      gradientVersion: 2, type: 'solid', interpolation: 'classic', smoothness: 0,
      stops: [{ pos: 0, mid: 0.5, color: '#102080' }, { pos: 0.5, mid: 0.25, color: '#f0c020' }, { pos: 1, mid: 0.5, color: '#c01040' }],
      opacityStops: [{ pos: 0, mid: 0.5, opacity: 1 }, { pos: 0.7, mid: 0.5, opacity: 0.4 }, { pos: 1, mid: 0.5, opacity: 1 }],
    };
    await fill('gradient-v2', { type: 'gradient', gradient: { ...def, kind: 'linear', reverse: false, dither: false, from: [2, 12], to: [30, 12] } });
    for (const interpolation of ['perceptual', 'linear', 'smooth', 'stripes']) {
      await fill(`gradient-v2-${interpolation}`, { type: 'gradient', gradient: { ...def, interpolation, smoothness: 1, opacityStops: [{ pos: 0, mid: 0.5, opacity: 1 }, { pos: 1, mid: 0.5, opacity: 1 }], kind: 'linear', reverse: false, dither: false, from: [2, 12], to: [30, 12] } });
    }
    await fill('gradient-v2-smoothness', { type: 'gradient', gradient: { ...def, smoothness: 1, kind: 'radial', reverse: true, dither: false, from: [16, 12], to: [30, 12] } });
    await fill('gradient-noise', {
      type: 'gradient',
      gradient: { gradientVersion: 2, type: 'noise', interpolation: 'classic', smoothness: 0, stops: def.stops, opacityStops: def.opacityStops, noise: { roughness: 0.4, model: 'rgb', min: [0, 0.2, 0], max: [1, 0.8, 1], restrict: true, transparency: false, seed: 7 }, kind: 'linear', reverse: false, dither: false, from: [0, 12], to: [32, 12] },
    });
    await fill('pattern-placed', { type: 'pattern', pattern: { canvas: tile(), scale: 1.5, angle: 0, link: true, origin: [1, 2], presetId: 'user-quarters', name: 'Quarters' } });
    await fill('pattern-turned', { type: 'pattern', pattern: { canvas: tile(), scale: 2, angle: 90, link: false, origin: [0, 0], name: 'Quarters' } });
  }

  // ---- shape layers ----------------------------------------------------------------------------

  async function shape(name, props) {
    const doc = new Document({ width: 40, height: 32, name: `Shape ${name}` });
    background(doc);
    add(doc.root, new ShapeLayer({ name: 'Shape', ...props }));
    await saveBoth(`shape-${name}`, doc);
  }
  const box = (x, y, w, h) => ({ closed: true, points: [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }] });
  // a path with a hole cut by an operation, 0.3's stroke (a colour) and its box-based parameters
  await shape('path-subtract', { path: { subpaths: [box(4, 4, 30, 22), { ...box(12, 10, 10, 8), op: 'subtract' }] }, fill: { type: 'solid', color: '#208040' }, stroke: { color: '#402000', width: 2, align: 'center', dash: [] }, shapeKind: 'path', shapeProps: {} });
  // two subpaths without operations: one fill, the inner one wound the other way cuts a hole
  await shape('path-winding', { path: { subpaths: [box(4, 4, 30, 22), { closed: true, points: [{ x: 12, y: 10 }, { x: 12, y: 18 }, { x: 22, y: 18 }, { x: 22, y: 10 }] }] }, fill: { type: 'solid', color: '#804020' }, stroke: null, shapeKind: 'path', shapeProps: {} });
  await shape('path-intersect-exclude', { path: { subpaths: [box(4, 4, 20, 16), { ...box(14, 10, 20, 16), op: 'intersect' }, { ...box(16, 12, 20, 6), op: 'exclude' }] }, fill: { type: 'solid', color: '#2040a0' }, stroke: null, shapeKind: 'path', shapeProps: {} });
  await shape('no-fill-stroke-inside', { path: { subpaths: [box(6, 6, 28, 20)] }, fill: null, stroke: { color: '#c00000', width: 4, align: 'inside', dash: [] }, shapeKind: 'path', shapeProps: {} });
  await shape('stroke-outside-dashed', { path: { subpaths: [box(8, 8, 24, 16)] }, fill: { type: 'solid', color: '#ffe080' }, stroke: { color: '#000080', width: 3, align: 'outside', dash: [2, 1] }, shapeKind: 'path', shapeProps: {} });
  await shape('gradient-fill', { path: { subpaths: [box(4, 6, 32, 20)] }, fill: { type: 'gradient', gradient: { kind: 'linear', stops: stops03 } }, stroke: null, shapeKind: 'path', shapeProps: {} });
  await shape('open-curve', {
    path: { subpaths: [{ closed: false, points: [{ x: 4, y: 26, outX: 12, outY: 2 }, { x: 20, y: 16, inX: 14, inY: 30, outX: 26, outY: 2 }, { x: 36, y: 8, inX: 30, inY: 28 }] }] },
    fill: null, stroke: { color: '#6020a0', width: 3, align: 'center', dash: [] }, shapeKind: 'path', shapeProps: {},
  });
  // 0.3's live shapes: box-based parameters
  await shape('rect-03', { path: { subpaths: [box(6, 5, 26, 20)] }, fill: { type: 'solid', color: '#4f81ff' }, stroke: null, shapeKind: 'rect', shapeProps: { x: 6, y: 5, width: 26, height: 20, radius: 0 } });
  if (v3) {
    const G = await lib('renderer/lib/shape-geometry.js');
    const live = async (name, kind, shapeProps, extra = {}) => shape(name, { path: G.shapePath(kind, shapeProps), fill: { type: 'solid', color: '#4f81ff' }, stroke: null, shapeKind: kind, shapeProps, ...extra });
    await live('rect', 'rect', { x: 5, y: 4, width: 30, height: 22, angle: 0, radii: [6, 0, 3, 9] });
    await live('rect-turned', 'rect', { x: 8, y: 8, width: 24, height: 14, angle: 20, radii: [0, 0, 0, 0] });
    await live('ellipse', 'ellipse', { x: 4, y: 6, width: 32, height: 20, angle: 0 });
    await live('triangle', 'triangle', { x: 6, y: 4, width: 28, height: 24, angle: 0, radius: 3 });
    await live('polygon', 'polygon', { x: 8, y: 4, width: 24, height: 24, angle: 0, sides: 6, starRatio: 100, smoothCorners: false, smoothIndents: false, cornerRadius: 0 });
    await live('star', 'polygon', { x: 8, y: 4, width: 24, height: 24, angle: 0, sides: 5, starRatio: 45, smoothCorners: false, smoothIndents: false, cornerRadius: 0 });
    await live('star-smooth', 'polygon', { x: 8, y: 4, width: 24, height: 24, angle: 0, sides: 5, starRatio: 45, smoothCorners: true, smoothIndents: true, cornerRadius: 0 });
    await live('line', 'line', { x1: 5, y1: 26, x2: 34, y2: 6, weight: 4, arrowStart: null, arrowEnd: null });
    await live('line-arrow', 'line', { x1: 6, y1: 16, x2: 34, y2: 16, weight: 3, arrowStart: null, arrowEnd: { width: 400, length: 500, concavity: 20 } });
    await live('custom', 'custom', { x: 8, y: 4, width: 24, height: 24, angle: 0, shape: 'heart' });
    // 0.4's stroke: a paint, caps, joins, and dashes in stroke widths
    await shape('stroke-options', {
      path: { subpaths: [{ closed: false, points: [{ x: 6, y: 24 }, { x: 14, y: 8 }, { x: 24, y: 24 }, { x: 34, y: 8 }] }] },
      fill: null,
      stroke: { paint: { type: 'gradient', gradient: { gradientVersion: 2, type: 'solid', interpolation: 'classic', smoothness: 0, stops: [{ pos: 0, mid: 0.5, color: '#ff0000' }, { pos: 1, mid: 0.5, color: '#0000ff' }], opacityStops: [{ pos: 0, mid: 0.5, opacity: 1 }, { pos: 1, mid: 0.5, opacity: 1 }], kind: 'linear', angle: 0, scale: 1 } }, width: 4, align: 'center', dash: [1, 2], dashOffset: 0.5, cap: 'round', join: 'round', miterLimit: 4 },
      shapeKind: 'path', shapeProps: {},
    });
    await shape('gradient-placed', {
      path: { subpaths: [box(4, 6, 32, 20)] },
      fill: { type: 'gradient', gradient: { gradientVersion: 2, type: 'solid', interpolation: 'classic', smoothness: 0, stops: [{ pos: 0, mid: 0.5, color: '#ffffff' }, { pos: 1, mid: 0.5, color: '#104080' }], opacityStops: [{ pos: 0, mid: 0.5, opacity: 1 }, { pos: 1, mid: 0.5, opacity: 1 }], kind: 'radial', angle: 0, scale: 0.8, offset: [-20, 10], reverse: false } },
      stroke: null, shapeKind: 'path', shapeProps: {},
    });
    // a pattern paint keeps its pixels as a data URL
    const P = await lib('renderer/lib/patterns.js');
    const canvas = tile();
    await shape('pattern-fill', { path: { subpaths: [box(4, 4, 32, 24)] }, fill: { type: 'pattern', pattern: { canvas, dataUrl: P.patternFromCanvas(canvas), scale: 1, angle: 0, link: true, origin: [0, 0], name: 'Quarters' } }, stroke: null, shapeKind: 'path', shapeProps: {} });
  }

  // ---- vector masks (0.4) ----------------------------------------------------------------------

  if (v3) {
    const doc = new Document({ width: 32, height: 32, name: 'Vector masks' });
    background(doc);
    const solid = (name, color, props = {}) => add(doc.root, new RasterLayer({ name, canvas: canvasFrom(32, 32, () => color), x: 0, y: 0, ...props }));
    const vm = (path, rest = {}) => ({ path, enabled: true, linked: true, density: 1, feather: 0, initialFill: 'hide', ...rest });
    solid('Hide', [255, 0, 0, 255], { vectorMask: vm({ subpaths: [box(2, 2, 12, 12), { ...box(6, 6, 4, 4), op: 'subtract' }] }) });
    solid('Reveal', [0, 160, 0, 255], { vectorMask: vm({ subpaths: [{ ...box(0, 0, 32, 16), op: 'subtract' }, { ...box(0, 16, 16, 16), op: 'subtract' }, { ...box(20, 20, 6, 6), op: 'subtract' }] }, { initialFill: 'reveal' }) });
    solid('Soft', [0, 0, 255, 255], { vectorMask: vm({ subpaths: [box(18, 2, 12, 12)] }, { density: 0.75, feather: 1.5, linked: false }) });
    solid('Disabled', [0, 0, 0, 255], { vectorMask: vm({ subpaths: [box(0, 0, 4, 4)] }, { enabled: false }), visible: false });
    solid('Reveal all', [255, 255, 0, 255], { vectorMask: vm({ subpaths: [] }, { initialFill: 'reveal' }), opacity: 0.25 });
    const group = add(doc.root, new GroupLayer({ name: 'Group', vectorMask: vm({ subpaths: [box(2, 18, 12, 12)] }) }));
    add(group, new RasterLayer({ name: 'Inside', canvas: canvasFrom(32, 32, () => [255, 0, 255, 255]), x: 0, y: 0 }));
    // with a layer mask as well: the layer shows where both show
    const both = solid('Both masks', [0, 255, 255, 255], { vectorMask: vm({ subpaths: [box(18, 18, 12, 12)] }) });
    both.mask = { canvas: canvasFrom(32, 32, (x, y) => (y < 24 ? [255, 255, 255, 255] : [0, 0, 0, 255])), enabled: true, linked: true };
    await saveBoth('vector-masks', doc);
  }

  // ---- layer styles ----------------------------------------------------------------------------

  const on = (fx) => ({ enabled: true, ...fx });
  // 0.3's effects, each alone, with nothing at its default
  await saveBoth('style-drop-shadow', styled('Drop shadow', { dropShadow: on({ blend: 'multiply', color: '#400080', opacity: 0.8, angle: 135, distance: 4, spread: 1, size: 3 }) }));
  await saveBoth('style-inner-shadow', styled('Inner shadow', { innerShadow: on({ blend: 'multiply', color: '#000000', opacity: 0.9, angle: 60, distance: 3, spread: 1, size: 2 }) }));
  await saveBoth('style-outer-glow', styled('Outer glow', { outerGlow: on({ blend: 'normal', color: '#ff4000', opacity: 0.9, spread: 1, size: 4 }) }));
  await saveBoth('style-inner-glow', styled('Inner glow', { innerGlow: on({ blend: 'screen', color: '#ffff40', opacity: 1, source: 'edge', choke: 1, size: 4 }) }));
  await saveBoth('style-inner-glow-center', styled('Inner glow from the centre', { innerGlow: on({ blend: 'normal', color: '#ffffff', opacity: 0.8, source: 'center', choke: 0, size: 5 }) }));
  for (const style of ['inner-bevel', 'outer-bevel', 'emboss', 'pillow-emboss']) {
    await saveBoth(`style-bevel-${style}`, styled(`Bevel ${style}`, {
      bevel: on({ style, technique: style === 'emboss' ? 'chisel-hard' : 'smooth', depth: 150, direction: style === 'outer-bevel' ? 'down' : 'up', size: 4, soften: style === 'inner-bevel' ? 1 : 0, angle: 135, altitude: 40, highlightColor: '#ffffc0', highlightOpacity: 0.9, highlightBlend: 'screen', shadowColor: '#200040', shadowOpacity: 0.8, shadowBlend: 'multiply' }),
    }));
  }
  await saveBoth('style-satin', styled('Satin', { satin: on({ color: '#000060', opacity: 0.7, blend: 'multiply', angle: 45, distance: 5, size: 4, invert: false }) }));
  await saveBoth('style-color-overlay', styled('Color overlay', { colorOverlay: on({ color: '#e02060', opacity: 0.6, blend: 'normal' }) }));
  await saveBoth('style-gradient-overlay', styled('Gradient overlay', { gradientOverlay: on({ stops: [{ pos: 0, color: '#ff0000' }, { pos: 0.5, color: '#00ff00', opacity: 0.5 }, { pos: 1, color: '#0000ff' }], kind: 'linear', angle: 30, scale: 0.8, opacity: 0.9, blend: 'normal', reverse: true }) }));
  for (const kind of ['radial', 'angle', 'reflected', 'diamond']) {
    await saveBoth(`style-gradient-overlay-${kind}`, styled(`Gradient overlay ${kind}`, { gradientOverlay: on({ stops: [{ pos: 0, color: '#ffff00' }, { pos: 1, color: '#800080' }], kind, angle: 45, scale: 1, opacity: 1, blend: 'normal', reverse: false }) }));
  }
  for (const position of ['outside', 'inside', 'center']) {
    await saveBoth(`style-stroke-${position}`, styled(`Stroke ${position}`, { stroke: on({ size: 3, position, color: '#c00000', opacity: 0.8, blend: 'normal' }) }));
  }
  // several at once, one switched off, with the layer's fill opacity lowered
  await saveBoth('style-several', styled('Several', {
    dropShadow: on({ blend: 'multiply', color: '#000000', opacity: 0.6, angle: 120, distance: 3, spread: 0, size: 3 }),
    innerShadow: { enabled: false, blend: 'multiply', color: '#ff0000', opacity: 1, angle: 0, distance: 9, spread: 0, size: 1 },
    colorOverlay: on({ color: '#ffd000', opacity: 1, blend: 'multiply' }),
    stroke: on({ size: 2, position: 'outside', color: '#202020', opacity: 1, blend: 'normal' }),
  }, { fillOpacity: 0.5 }));
  {
    // 0.3 kept a pattern overlay's pixels as a data URL
    const doc = styled('Pattern overlay', { patternOverlay: on({ pattern: tile().toDataURL('image/png'), scale: 2, opacity: 0.9, blend: 'normal' }) });
    if (v3) (await lib('renderer/lib/patterns.js')).patternFromCanvas(tile()); // decoded for the picture
    else doc.root.children[1].styles.patternOverlay.enabled = v3; // 0.3 decoded patterns in the page only: no picture of it
    await (v3 ? saveBoth : (n, d) => save(`${set}-${n}`, d))('style-pattern-overlay', doc);
  }
  if (v3) {
    const P = await lib('renderer/lib/patterns.js');
    const ref = { dataUrl: P.patternFromCanvas(tile()), presetId: 'user-quarters', name: 'Quarters' };
    const cone = { name: 'Cone', points: [{ x: 0, y: 0, corner: false }, { x: 0.5, y: 1, corner: true }, { x: 1, y: 0, corner: false }] };
    const gradient = {
      gradientVersion: 2, type: 'solid', interpolation: 'classic', smoothness: 0,
      stops: [{ pos: 0, mid: 0.5, color: '#ff00ff' }, { pos: 1, mid: 0.5, color: '#00ffff' }],
      opacityStops: [{ pos: 0, mid: 0.5, opacity: 1 }, { pos: 1, mid: 0.5, opacity: 0.2 }],
    };
    // several instances of one effect: the first is the top one
    await saveBoth('style-drop-shadows', styled('Three drop shadows', {
      dropShadow: [
        on({ blend: 'normal', color: '#ff0000', opacity: 1, angle: 0, distance: 6, spread: 0, size: 0, knocksOut: true }),
        on({ blend: 'normal', color: '#00a000', opacity: 1, angle: 90, distance: 6, spread: 0, size: 0, knocksOut: false }),
        { enabled: false, blend: 'normal', color: '#0000ff', opacity: 1, angle: 180, distance: 6, spread: 0, size: 0 },
      ],
    }));
    await saveBoth('style-strokes', styled('Two strokes', { stroke: [on({ size: 2, position: 'outside', color: '#000000', opacity: 1, blend: 'normal' }), on({ size: 5, position: 'outside', color: '#ffc000', opacity: 1, blend: 'normal' })] }));
    await saveBoth('style-shadow-options', styled('Shadow options', { dropShadow: on({ blend: 'multiply', color: '#000000', opacity: 1, angle: 120, useGlobalLight: true, distance: 5, spread: 0, size: 6, contour: cone, antiAlias: true, noise: 0.3, knocksOut: false }) }));
    await saveBoth('style-outer-glow-precise', styled('Outer glow, precise', { outerGlow: on({ blend: 'normal', color: '#0060ff', opacity: 1, spread: 1, size: 5, technique: 'precise', contour: null, antiAlias: false, range: 0.7, jitter: 0, noise: 0, fill: 'color', gradient: null }) }));
    await saveBoth('style-outer-glow-gradient', styled('Outer glow, gradient', { outerGlow: on({ blend: 'normal', color: '#ffffff', opacity: 1, spread: 0, size: 6, technique: 'softer', contour: null, antiAlias: false, range: 0.5, jitter: 0, noise: 0, fill: 'gradient', gradient }) }));
    await saveBoth('style-bevel-options', styled('Bevel options', {
      bevel: on({
        style: 'inner-bevel', technique: 'chisel-soft', depth: 200, direction: 'up', size: 5, soften: 0, angle: 120, altitude: 30, useGlobalLight: true,
        highlightColor: '#ffffff', highlightOpacity: 0.75, highlightBlend: 'screen', shadowColor: '#000000', shadowOpacity: 0.75, shadowBlend: 'multiply',
        glossContour: cone, antiAlias: true,
        contourSub: { enabled: true, contour: cone, antiAlias: false, range: 0.6 },
        texture: { enabled: true, pattern: ref, scale: 2, depth: 0.5, invert: true, link: true, origin: [1, 1] },
      }),
    }));
    await saveBoth('style-satin-contour', styled('Satin with a contour', { satin: on({ color: '#ffffff', opacity: 0.8, blend: 'screen', angle: 19, distance: 4, size: 5, invert: true, contour: cone, antiAlias: true }) }));
    await saveBoth('style-gradient-overlay-v2', styled('Gradient overlay 0.4', { gradientOverlay: on({ gradient, kind: 'linear', angle: 0, scale: 1.5, opacity: 1, blend: 'normal', reverse: false, offset: [10, -20], align: false, dither: true }) }));
    await saveBoth('style-pattern-overlay-v2', styled('Pattern overlay 0.4', { patternOverlay: on({ pattern: ref, scale: 1, opacity: 1, blend: 'multiply', angle: 0, link: false, origin: [2, 1] }) }));
    await saveBoth('style-stroke-gradient', styled('Gradient stroke', { stroke: on({ size: 4, position: 'outside', color: '#000000', opacity: 1, blend: 'normal', fill: 'gradient', gradient, kind: 'linear', angle: 90, scale: 1, offset: [0, 0], align: true, reverse: true, dither: false }) }));
    await saveBoth('style-stroke-pattern', styled('Pattern stroke', { stroke: on({ size: 4, position: 'center', color: '#000000', opacity: 1, blend: 'normal', fill: 'pattern', pattern: ref, patternScale: 1, patternAngle: 0, link: true, origin: [0, 0] }) }));
    await saveBoth('style-hidden', styled('Effects hidden', { hidden: true, colorOverlay: on({ color: '#ff0000', opacity: 1, blend: 'normal' }), stroke: on({ size: 3, position: 'outside', color: '#000000', opacity: 1, blend: 'normal' }) }));
    // styles on a group and on a shape
    {
      const doc = new Document({ width: 32, height: 32, name: 'Styles on a group and a shape' });
      background(doc);
      const group = add(doc.root, new GroupLayer({ name: 'Group', blend: 'normal' }));
      group.styles = { stroke: on({ size: 2, position: 'outside', color: '#008000', opacity: 1, blend: 'normal' }) };
      add(group, new RasterLayer({ name: 'A', canvas: canvasFrom(8, 8, () => [255, 255, 0, 255]), x: 3, y: 3 }));
      add(group, new RasterLayer({ name: 'B', canvas: canvasFrom(8, 8, () => [255, 128, 0, 255]), x: 8, y: 8 }));
      const s = add(doc.root, new ShapeLayer({ name: 'Shape', path: { subpaths: [box(18, 18, 10, 10)] }, fill: { type: 'solid', color: '#4040c0' }, stroke: null }));
      s.styles = { dropShadow: on({ blend: 'multiply', color: '#000000', opacity: 0.75, angle: 120, distance: 3, spread: 0, size: 2 }) };
      await saveBoth('style-group-shape', doc);
    }
  }

  // ---- advanced blending (0.4) -----------------------------------------------------------------

  if (v3) {
    const range = [0, 0, 255, 255];
    const blendIf = (over = {}) => ({ gray: { this: range, under: range }, r: { this: range, under: range }, g: { this: range, under: range }, b: { this: range, under: range }, ...over });
    async function blending(name, blending, props = {}, below = null) {
      const doc = photo(`Blending ${name}`);
      if (below) below(doc);
      add(doc.root, new RasterLayer({ name: 'Blended', canvas: canvasFrom(SIZE, SIZE, (x, y) => [x * 10, 255 - y * 10, 128, x + y < 6 ? 0 : 255]), x: 0, y: 0, blending, ...props }));
      await saveBoth(`blending-${name}`, doc);
    }
    await blending('channels', { channels: { r: true, g: false, b: true } });
    // split points: the layer fades in over 40..90 of its own grey, and out where what is below is bright
    await blending('blend-if', { blendIf: blendIf({ gray: { this: [40, 90, 255, 255], under: [0, 0, 150, 220] } }) });
    await blending('blend-if-channels', { blendIf: blendIf({ r: { this: [100, 100, 255, 255], under: range }, b: { this: range, under: [0, 60, 255, 255] } }) });
    await blending('knockout-shallow', { knockout: 'shallow' }, { fillOpacity: 0.3 }, (doc) => {
      add(doc.root, new RasterLayer({ name: 'Between', canvas: canvasFrom(SIZE, SIZE, () => [0, 0, 0, 255]), x: 0, y: 0 }));
    });
    await blending('flags', { interiorAsGroup: true, clippedAsGroup: false, transparencyShapes: false, maskHidesEffects: true, vectorMaskHidesEffects: true, knockout: 'deep' }, { opacity: 0.8 });
  }
}
