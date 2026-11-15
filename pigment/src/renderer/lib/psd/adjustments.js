// Adjustment and fill layers ↔ PSD (ARCHITECTURE.md "0.5 features", S4.3: kinds `adjustment` 200 and `fill` 300).
// psd-layers' file (lib/io.js re-exports adjustmentToPsd and adjustmentFromPsd).
//
// Adjustments: every Pigment adjustment with a PSD form stays an editable adjustment layer both ways: 0.4's mapping
// (Levels, Curves, Brightness/Contrast, Exposure, Vibrance, Hue/Saturation with its colour ranges, Color Balance,
// Black & White, Photo Filter, Channel Mixer, Posterize, Threshold, Gradient Map, Selective Color, Invert), plus
// Hue/Saturation's Colorize (the flag and the colorization values sit in the record's first eight bytes, which ag-psd
// reads as the master channel's range) and Color Lookup (the table as .cube data, or a built-in look by name).
// What has no PSD form keeps its slot as a hidden empty layer, as 0.4 did, with 0.4's notice.
//
// Fill layers: Solid Color, Gradient (style, angle, scale, offset, reverse, dither, method; Pigment's document-space
// from / to through the Gradient Fill dialog's placement) and Pattern (scale, angle, Link with Layer, Snap to Origin
// offset; the pixels in the file's patterns) as 'SoCo' / 'GdFl' / 'PtFl'. In a Grayscale, Duotone or Multichannel
// document a fill is written natively only when its colours are what the document shows (S4.2).
import { registerPsdLayerKind, registerPsdAspect, registerPsdFeatures, registerPsdNotice } from './registry.js';
import { rgbFromPsd, psdColor, gradientToPsd, gradientFromPsd } from './convert.js';
import { paintFromContent, paintToContent, paintColors, addPatterns } from './paints.js';
import { AdjustmentLayer, RasterLayer, FillLayer, createCanvas } from '../document.js';
import { pointsFromTable } from '../../../shared/pixels/adjust-tonal.js';
import { HUE_BASES, DEFAULT_RANGE_BOUNDS, hueSatRanges, normalizeBounds } from '../../../shared/pixels/adjust-color.js';
import { adjustmentDef } from '../../../shared/pixels/adjust.js';
import { colorLookupTable } from '../../../shared/pixels/adjust-more.js';
import { writeCube, parseLut, LUT_PRESETS } from '../../../shared/pixels/lut.js';

/** What this file has landed (S15); merged into psdFeatures() by the registry. */
export const PSD_FEATURES = Object.freeze({ fills: true });
registerPsdFeatures(PSD_FEATURES);

const plural = (n, one, many) => (n === 1 ? one : many);

const lv = (c) => (c ? { shadowInput: c.inBlack ?? 0, highlightInput: c.inWhite ?? 255, shadowOutput: c.outBlack ?? 0, highlightOutput: c.outWhite ?? 255, midtoneInput: c.gamma ?? 1 } : undefined);
const lvBack = (c) => (c ? { inBlack: c.shadowInput ?? 0, inWhite: c.highlightInput ?? 255, gamma: c.midtoneInput ?? 1, outBlack: c.shadowOutput ?? 0, outWhite: c.highlightOutput ?? 255 } : null);
// a drawn (pencil) curve channel ({ table }, adjust-tonal) is written as points sampled from its table
const cv = (pts) => (pts?.table ? cv(pointsFromTable(pts, 19)) : Array.isArray(pts) ? pts.map(([input, output]) => ({ input, output })) : undefined);
const cvBack = (pts) => (Array.isArray(pts) && pts.length ? pts.map((p) => [p.input, p.output]) : null);
const hueCh = (p) => ({ a: 0, b: 0, c: 0, d: 0, hue: p?.hue ?? 0, saturation: p?.saturation ?? 0, lightness: p?.lightness ?? 0 });
const cb = (v) => ({ cyanRed: v?.[0] ?? 0, magentaGreen: v?.[1] ?? 0, yellowBlue: v?.[2] ?? 0 });
const cbBack = (v) => [v?.cyanRed ?? 0, v?.magentaGreen ?? 0, v?.yellowBlue ?? 0];
const mix = (c) => ({ red: c?.r ?? 0, green: c?.g ?? 0, blue: c?.b ?? 0, constant: c?.constant ?? 0 });
const mixBack = (c, def) => ({ r: c?.red ?? def.r, g: c?.green ?? def.g, b: c?.blue ?? def.b, constant: c?.constant ?? 0 });
const cmyk = (v) => ({ c: v?.c ?? 0, m: v?.m ?? 0, y: v?.y ?? 0, k: v?.k ?? 0 });
const SELECTIVE = ['reds', 'yellows', 'greens', 'cyans', 'blues', 'magentas', 'whites', 'neutrals', 'blacks'];

/** PSD adjustment data for a Pigment adjustment layer, or null when the kind has no PSD equivalent. */
export function adjustmentToPsd(kind, p = {}) {
  switch (kind) {
    case 'invert': return { type: 'invert' };
    case 'brightness-contrast': return { type: 'brightness/contrast', brightness: p.brightness ?? 0, contrast: p.contrast ?? 0, useLegacy: !!p.legacy };
    case 'levels': return { type: 'levels', rgb: lv(p.rgb ?? {}), red: lv(p.r), green: lv(p.g), blue: lv(p.b) };
    case 'curves': return { type: 'curves', rgb: cv(p.rgb ?? [[0, 0], [255, 255]]), red: cv(p.r), green: cv(p.g), blue: cv(p.b) };
    case 'exposure': return { type: 'exposure', exposure: p.exposure ?? 0, offset: p.offset ?? 0, gamma: p.gamma ?? 1 };
    case 'vibrance': return { type: 'vibrance', vibrance: p.vibrance ?? 0, saturation: p.saturation ?? 0 };
    case 'hue-saturation': {
      // Master and the colour ranges (J.9): PSD keeps one record per range in Photoshop's order, its bounds a..d in
      // degrees with its three values; an unused range is written with its default bounds and no change, as Photoshop
      // does. (0.3's single `range` comes through hueSatRanges as that one range.)
      const { master, ranges } = hueSatRanges(p);
      const slot = (base) => {
        const r = ranges.find((x) => x.base === base);
        const [a, b, c, d] = (r?.bounds ?? DEFAULT_RANGE_BOUNDS[base]).map(Math.round);
        return { a, b, c, d, hue: Math.round(r?.hue ?? 0), saturation: Math.round(r?.saturation ?? 0), lightness: Math.round(r?.lightness ?? 0) };
      };
      // Colorize: the flag byte, a padding byte and the colorization hue, saturation and lightness come before the
      // master values, which ag-psd reads as the master channel's a (flag << 8), b, c, d
      const m = hueCh({ hue: Math.round(master.hue), saturation: Math.round(master.saturation), lightness: Math.round(master.lightness) });
      if (p.colorize) Object.assign(m, { a: 256, b: Math.round(p.colorizeHue ?? 0), c: Math.round(p.colorizeSat ?? 25), d: Math.round(p.colorizeLight ?? 0) });
      return { type: 'hue/saturation', master: m, ...Object.fromEntries(HUE_BASES.map((b) => [b, slot(b)])) };
    }
    case 'color-balance': return { type: 'color balance', shadows: cb(p.shadows), midtones: cb(p.midtones), highlights: cb(p.highlights), preserveLuminosity: p.preserveLuminosity !== false };
    case 'black-white': return { type: 'black & white', reds: p.reds ?? 40, yellows: p.yellows ?? 60, greens: p.greens ?? 40, cyans: p.cyans ?? 60, blues: p.blues ?? 20, magentas: p.magentas ?? 80, useTint: !!p.tint, tintColor: psdColor(p.tint || '#e6c8a0') };
    case 'photo-filter': return { type: 'photo filter', color: psdColor(p.color ?? '#ec8a00'), density: p.density ?? 25, preserveLuminosity: p.preserveLuminosity !== false };
    case 'channel-mixer': return { type: 'channel mixer', monochrome: !!p.monochrome, red: mix(p.r ?? { r: 100 }), green: mix(p.g ?? { g: 100 }), blue: mix(p.b ?? { b: 100 }), gray: mix(p.gray ?? { r: 40, g: 40, b: 20 }) };
    case 'posterize': return { type: 'posterize', levels: p.levels ?? 4 };
    case 'threshold': return { type: 'threshold', level: p.level ?? 128 };
    // a v2 def (G.1) keeps its midpoints, opacity stops and method (convert.js gradientToPsd)
    case 'gradient-map': return { type: 'gradient map', ...gradientToPsd(p) };
    case 'selective-color': return { type: 'selective color', mode: p.relative === false ? 'absolute' : 'relative', ...Object.fromEntries(SELECTIVE.map((k) => [k, cmyk(p[k])])) };
    case 'color-lookup': {
      // the table as a .cube file inside the layer, Photoshop's form for a loaded 3D LUT
      const lut = colorLookupTable(p);
      const preset = typeof p.preset === 'string' && p.preset !== 'none' ? p.preset : null;
      if (!lut) return { type: 'color lookup', lookupType: '3dlut', name: '', dither: !!p.dither };
      const name = preset ?? (lut.title || 'Custom');
      return { type: 'color lookup', lookupType: '3dlut', name, dither: !!p.dither, lutFormat: 'cube', lut3DFileName: `${name}.cube`, lut3DFileData: new TextEncoder().encode(writeCube(lut, { title: name })) };
    }
    default: return null;
  }
}

/** Color Lookup params for ag-psd's color lookup data, or null when Pigment cannot use it (an ICC abstract or device link). */
function colorLookupFromPsd(a) {
  if (a.lookupType && a.lookupType !== '3dlut') return null;
  const base = (a.name ?? '').replace(/\.[^.]+$/, '');
  if (!a.lut3DFileData?.length) {
    // a built-in look Pigment has under the same name, or an empty layer
    if (base && Object.prototype.hasOwnProperty.call(LUT_PRESETS, base)) return { preset: base, lut: null, dither: !!a.dither };
    return a.name ? null : { preset: 'none', lut: null, dither: !!a.dither };
  }
  try {
    const lut = parseLut(new TextDecoder().decode(a.lut3DFileData), a.lut3DFileName ?? `${base || 'Lookup'}.${a.lutFormat === '3dl' ? '3dl' : a.lutFormat === 'look' ? 'look' : 'cube'}`);
    if (base && Object.prototype.hasOwnProperty.call(LUT_PRESETS, base)) return { preset: base, lut: null, dither: !!a.dither };
    return { preset: 'none', lut, dither: !!a.dither };
  } catch {
    return null;
  }
}

/** { kind, params } for ag-psd adjustment data, or null when Pigment has no such adjustment. */
export function adjustmentFromPsd(a) {
  if (!a?.type) return null;
  switch (a.type) {
    case 'invert': return { kind: 'invert', params: {} };
    case 'brightness/contrast': return { kind: 'brightness-contrast', params: { brightness: a.brightness ?? 0, contrast: a.contrast ?? 0, legacy: !!a.useLegacy } };
    case 'levels': return { kind: 'levels', params: { perChannel: !!(a.red || a.green || a.blue), rgb: lvBack(a.rgb) ?? { inBlack: 0, inWhite: 255, gamma: 1, outBlack: 0, outWhite: 255 }, r: lvBack(a.red), g: lvBack(a.green), b: lvBack(a.blue) } };
    case 'curves': return { kind: 'curves', params: { rgb: cvBack(a.rgb) ?? [[0, 0], [255, 255]], r: cvBack(a.red), g: cvBack(a.green), b: cvBack(a.blue) } };
    case 'exposure': return { kind: 'exposure', params: { exposure: a.exposure ?? 0, offset: a.offset ?? 0, gamma: a.gamma ?? 1 } };
    case 'vibrance': return { kind: 'vibrance', params: { vibrance: a.vibrance ?? 0, saturation: a.saturation ?? 0 } };
    case 'hue/saturation': {
      const m = a.master ?? a.channels?.[0] ?? {};
      // the colour ranges that change something (J.9), with their bounds (all zero in files 0.3 wrote: the defaults)
      const ranges = [];
      for (const base of HUE_BASES) {
        const c = a[base];
        if (!c || (!c.hue && !c.saturation && !c.lightness)) continue;
        const raw = [c.a, c.b, c.c, c.d];
        const bounds = raw.every((v) => !v) ? null : normalizeBounds(raw);
        ranges.push({ base, bounds: bounds ?? [...DEFAULT_RANGE_BOUNDS[base]], hue: c.hue ?? 0, saturation: c.saturation ?? 0, lightness: c.lightness ?? 0 });
      }
      const colorize = ((m.a ?? 0) & 0xff00) !== 0;
      return { kind: 'hue-saturation', params: { hue: m.hue ?? 0, saturation: m.saturation ?? 0, lightness: m.lightness ?? 0, colorize, colorizeHue: colorize ? m.b ?? 0 : 0, colorizeSat: colorize ? m.c ?? 25 : 25, colorizeLight: colorize ? m.d ?? 0 : 0, range: 'master', ranges } };
    }
    case 'color balance': return { kind: 'color-balance', params: { shadows: cbBack(a.shadows), midtones: cbBack(a.midtones), highlights: cbBack(a.highlights), preserveLuminosity: a.preserveLuminosity !== false } };
    case 'black & white': return { kind: 'black-white', params: { reds: a.reds ?? 40, yellows: a.yellows ?? 60, greens: a.greens ?? 40, cyans: a.cyans ?? 60, blues: a.blues ?? 20, magentas: a.magentas ?? 80, tint: a.useTint ? rgbFromPsd(a.tintColor, '#e6c8a0') : null } };
    case 'photo filter': return { kind: 'photo-filter', params: { color: rgbFromPsd(a.color, '#ec8a00'), density: a.density ?? 25, preserveLuminosity: a.preserveLuminosity !== false } };
    case 'channel mixer': return { kind: 'channel-mixer', params: { r: mixBack(a.red, { r: 100, g: 0, b: 0 }), g: mixBack(a.green, { r: 0, g: 100, b: 0 }), b: mixBack(a.blue, { r: 0, g: 0, b: 100 }), gray: mixBack(a.gray, { r: 40, g: 40, b: 20 }), monochrome: !!a.monochrome } };
    case 'posterize': return { kind: 'posterize', params: { levels: a.levels ?? 4 } };
    case 'threshold': return { kind: 'threshold', params: { level: a.level ?? 128 } };
    case 'gradient map': return { kind: 'gradient-map', params: gradientFromPsd(a) };
    case 'selective color': return { kind: 'selective-color', params: { ...Object.fromEntries(SELECTIVE.map((k) => [k, cmyk(a[k])])), relative: a.mode !== 'absolute' } };
    case 'color lookup': {
      const params = colorLookupFromPsd(a);
      return params ? { kind: 'color-lookup', params } : null;
    }
    default: return null;
  }
}

// Adjustments Pigment has no equivalent for, both ways, keep their slot as a hidden empty layer so the layer order
// survives; the aspect below gives the slot its name and hides it after the common aspect wrote the layer's own.
const placeholders = new WeakSet(); // layers read, and records written, as such slots

registerPsdLayerKind({
  id: 'adjustment',
  order: 200,
  test: (pl) => !!pl.adjustment,
  read(pl, ctx) {
    const { doc } = ctx;
    const adj = adjustmentFromPsd(pl.adjustment);
    if (!adj) {
      const layer = new RasterLayer({ canvas: createCanvas(1, 1), x: 0, y: 0 });
      placeholders.add(layer);
      return layer;
    }
    const layer = new AdjustmentLayer({ kind: adj.kind, params: adj.params });
    if (!(pl.mask?.canvas && !pl.mask.fromVectorData)) {
      // Photoshop adjustment layers always carry a mask; an absent one means "reveal all"
      const m = createCanvas(doc.width, doc.height);
      m.getContext('2d').fillStyle = '#fff';
      m.getContext('2d').fillRect(0, 0, doc.width, doc.height);
      layer.mask = { canvas: m, enabled: true, linked: true };
    }
    ctx.claim(layer, 'adjustment');
    return layer;
  },
  match: (layer) => layer.type === 'adjustment',
  write(layer, ctx) {
    const adjustment = adjustmentToPsd(layer.kind, layer.params);
    if ((layer.kind === 'levels' || layer.kind === 'curves') && layer.params?.space && layer.params.space !== 'rgb') ctx.report.add('other-space');
    if (adjustment) {
      ctx.claim(layer, 'adjustment');
      return { adjustment };
    }
    ctx.report.add('no-psd-adjustment', adjustmentDef(layer.kind)?.name ?? layer.kind);
    const rec = { left: 0, top: 0, canvas: createCanvas(1, 1) };
    placeholders.add(rec);
    return rec;
  },
});

registerPsdAspect({
  id: 'adjustment-placeholder',
  order: 110,
  read(pl, layer, ctx) {
    if (!placeholders.has(layer)) return;
    layer.name = `${layer.name} (${pl.adjustment.type})`;
    layer.visible = false;
    ctx.report.add('psd-adjustment-unread', pl.adjustment.type);
  },
  write(layer, rec) {
    if (!placeholders.has(rec)) return;
    rec.name = `${layer.name} (${layer.kind})`;
    rec.hidden = true;
  },
});

registerPsdNotice('psd-adjustment-unread', {
  when: 'open',
  timeout: 6000,
  text: (n, kinds) => `${n} adjustment layer${plural(n, '', 's')} (${[...new Set(kinds)].join(', ')}) Pigment cannot use ${plural(n, 'was', 'were')} kept as ${plural(n, 'a hidden empty layer', 'hidden empty layers')}`,
});

// ---- fill layers (300) -------------------------------------------------------------------------------------------------

registerPsdLayerKind({
  id: 'fill',
  order: 300,
  // a fill without a stroke style or origination data (those are shapes, vector.js); a vector mask on it is the
  // layer's own (the vector-mask aspect)
  test: (pl) => !!pl.vectorFill && !pl.vectorStroke && !pl.vectorOrigination && !pl.adjustment,
  read(pl, ctx) {
    const { doc } = ctx;
    const paint = paintFromContent(pl.vectorFill, { place: 'document', width: doc.width, height: doc.height, patterns: ctx.patterns, profile: doc.profile ?? null, report: (d) => ctx.report.add('psd-fill-dropped', d) });
    if (!paint) return null;
    const layer = new FillLayer({ paint, docWidth: doc.width, docHeight: doc.height });
    ctx.claim(layer, 'fill');
    return layer;
  },
  match: (layer) => layer.type === 'fill',
  write(layer, ctx) {
    const { doc } = ctx;
    if (ctx.modeRendered && paintColors(layer.paint).some((c) => !c || !ctx.asShown(c))) return null;
    const resolve = doc.view?.app?.patterns?.resolve?.bind(doc.view.app.patterns) ?? null;
    const { content, patterns } = paintToContent(layer.paint, { place: 'document', width: doc.width, height: doc.height, resolve });
    if (!content) {
      if (layer.paint?.type === 'pattern') ctx.report.add('psd-shape-pattern');
      return null;
    }
    const r = layer.render();
    addPatterns(ctx.psd, patterns);
    ctx.claim(layer, 'fill');
    // the pixels too, for readers that do not render fills
    return { left: r.x, top: r.y, canvas: ctx.shown(r.canvas, r.x, r.y), vectorFill: content };
  },
});

registerPsdNotice('psd-fill-dropped', {
  when: 'open',
  timeout: 6000,
  text: (n, details) => `${n} fill layer${plural(n, '', 's')} with a ${[...new Set(details)].join(', ')} the file does not hold ${plural(n, 'was', 'were')} read as pixels`,
});
