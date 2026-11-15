// Paint conversions shared by psd-layers' mappers (effects.js, adjustments.js, vector.js): colours with alpha,
// gradients both ways (solid and noise, with their interpolation method), pattern pixels both ways, the Gradient
// Fill placement (angle / scale / offset <-> Pigment's from / to) and unit values. psd-layers' file; Node-safe (no
// DOM at import; canvases only where a function that needs one is called, as convert.js does).
import { parseColor } from '../../../shared/pixels/color.js';
import { normalizeGradient } from '../../../shared/pixels/gradient-model.js';
import { rgbFromPsd, psdColor, gradientFromPsd, psdGradientStops, patternToPsd, patternRefFromPsd, patternCanvas } from './convert.js';

const hex2 = (v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0');
const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** '#rrggbb' for an ag-psd colour: 0.4's rgbFromPsd plus the float RGB form ({ fr, fg, fb }, 0..1) ag-psd reads. */
export function hexFromPsd(c, fallback = '#000000', profile = null) {
  if (c && 'fr' in c) return `#${hex2(c.fr * 255)}${hex2(c.fg * 255)}${hex2(c.fb * 255)}`;
  return rgbFromPsd(c, fallback, profile);
}

/** ag-psd's { r, g, b } for a Pigment colour and the alpha it carried (0..1; '#rrggbbaa' and rgba() strings). */
export function colorToPsd(color, fallback = '#000000') {
  const [r, g, b, a] = parseColor(typeof color === 'string' ? color : fallback, parseColor(fallback));
  return { color: { r, g, b }, alpha: Number.isFinite(a) ? a : 1 };
}

/** A UnitsValue as pixels: Points and the physical units through the resolution (ppi), None / Density as numbers. */
export function unitsToPx(v, dpi = 72) {
  if (typeof v === 'number') return v;
  if (!v || typeof v.value !== 'number') return 0;
  const r = dpi > 0 ? dpi : 72;
  switch (v.units) {
    case 'Points': return (v.value * r) / 72;
    case 'Picas': return (v.value * 12 * r) / 72;
    case 'Inches': return v.value * r;
    case 'Centimeters': return (v.value * r) / 2.54;
    case 'Millimeters': return (v.value * r) / 25.4;
    default: return v.value;
  }
}

export const px = (value) => ({ units: 'Pixels', value: num(value) });

// ---- gradients --------------------------------------------------------------------------------------------------

const NOISE_MODELS = { rgb: 'rgb', hsb: 'hsb', lab: 'lab', hsl: 'hsb' };

/**
 * A Pigment GradientDef (v2) for an ag-psd gradient (a parsed 'Grad': solid or noise), with `interpolation` (an
 * effect's or fill's interpolation method, Photoshop's names). `report(detail)` hears what is approximated.
 */
export function gradientDefFromPsd(g, { interpolation = null, profile = null, report = null } = {}) {
  if (!g || typeof g !== 'object') return normalizeGradient(null);
  if (g.type === 'noise') {
    if (g.colorModel === 'hsl') report?.('noise gradient in HSL (read as HSB)');
    const three = (v, d) => (Array.isArray(v) ? [0, 1, 2].map((i) => Math.max(0, Math.min(1, num(v[i], d)))) : [d, d, d]);
    return normalizeGradient({
      gradientVersion: 2,
      type: 'noise',
      interpolation: 'classic',
      smoothness: 1,
      noise: { roughness: Math.max(0, Math.min(1, num(g.roughness, 0.5))), model: NOISE_MODELS[g.colorModel] ?? 'rgb', min: three(g.min, 0), max: three(g.max, 1), restrict: !!g.restrictColors, transparency: !!g.addTransparency, seed: Math.trunc(num(g.randomSeed, 1)) },
    });
  }
  // convert.js reads the stops (locations through the smoothness, colours through the profile); the method comes
  // from the effect or the fill, not from a grdm code
  const base = gradientFromPsd({ ...g, methodCode: undefined }, { profile });
  const def = normalizeGradient(base);
  // reverse and dither are the placement's (the effect's or the fill's), not the def's
  delete def.reverse;
  delete def.dither;
  if (interpolation && ['classic', 'perceptual', 'linear', 'smooth'].includes(interpolation)) def.interpolation = interpolation;
  else if (!base.gradientVersion) def.interpolation = 'classic';
  // the name travels for the Gradient Fill dialog and a later save
  if (typeof g.name === 'string' && g.name && g.name !== 'Custom') def.name = g.name;
  return def;
}

/**
 * An ag-psd gradient (EffectSolidGradient | EffectNoiseGradient: `{ type: 'solid', name, smoothness, colorStops,
 * opacityStops }` or `{ type: 'noise', … }`) and the interpolation method for a Pigment gradient of any shape.
 */
export function gradientDefToPsd(gradient, { report = null } = {}) {
  const def = normalizeGradient(gradient ?? null);
  const name = typeof gradient?.name === 'string' && gradient.name ? gradient.name : 'Custom';
  if (def.type === 'noise' && def.noise) {
    const n = def.noise;
    return {
      gradient: { type: 'noise', name, roughness: n.roughness, colorModel: n.model, randomSeed: n.seed, restrictColors: !!n.restrict, addTransparency: !!n.transparency, min: [...n.min, 0], max: [...n.max, 1] },
      interpolation: 'classic',
    };
  }
  let interpolation = def.interpolation;
  if (interpolation === 'stripes') {
    report?.('Stripes gradient method (saved as Classic)');
    interpolation = 'classic';
  }
  const stops = psdGradientStops(def.smoothness, def.stops.map((s) => ({ location: s.pos, midpoint: s.mid, color: psdColor(typeof s.color === 'string' ? s.color : '#000000') })), def.opacityStops.map((s) => ({ location: s.pos, midpoint: s.mid, opacity: s.opacity })));
  return { gradient: { type: 'solid', name, ...stops }, interpolation };
}

/** 0.3's Gradient Overlay `stops` kept in step with a def's colour stops (G.1: Pigment 0.3 still reads them). */
export const legacyStops = (def) => def.stops.filter((s) => typeof s.color === 'string').map((s) => ({ pos: s.pos, color: s.color }));

// ---- the Gradient Fill placement ----------------------------------------------------------------------------------
// Pigment's fill layers store document-space from / to; Photoshop's Gradient Fill stores angle, scale and offset over
// the layer (the document). The two maps below are those of the Gradient Fill dialog (lib/gradient-paint.js
// fillPlacement / fillEnds, which a Node-safe file cannot import), so a fill reads in the dialog with the numbers
// Photoshop shows.

const centred = (kind) => kind === 'radial' || kind === 'diamond' || kind === 'angle';

/** { angle (degrees), scale (percent), offsetX, offsetY (percent) } of from / to in a w x h document. */
export function fillPlacement(g, w, h) {
  if (!g?.from || !g?.to) return { angle: 0, scale: 100, offsetX: 0, offsetY: 0 };
  const radial = centred(g.kind);
  const vx = (g.to[0] - g.from[0]) / (radial ? 1 : 2), vy = (g.to[1] - g.from[1]) / (radial ? 1 : 2);
  const rad = Math.atan2(-vy, vx);
  const half0 = (Math.abs(Math.cos(rad)) * w + Math.abs(Math.sin(rad)) * h) / 2 || 1;
  const cx = radial ? g.from[0] : (g.from[0] + g.to[0]) / 2, cy = radial ? g.from[1] : (g.from[1] + g.to[1]) / 2;
  return { angle: (rad * 180) / Math.PI, scale: (Math.hypot(vx, vy) / half0) * 100, offsetX: ((cx - w / 2) / w) * 100, offsetY: ((cy - h / 2) / h) * 100 };
}

/** from / to for a kind, angle, scale and offset (percent) in a w x h document: fillPlacement's inverse. */
export function fillEnds({ kind = 'linear', angle = 0, scale = 100, offsetX = 0, offsetY = 0 }, w, h) {
  const rad = (angle * Math.PI) / 180;
  const cx = w / 2 + (offsetX / 100) * w, cy = h / 2 + (offsetY / 100) * h;
  const half = ((Math.abs(Math.cos(rad)) * w + Math.abs(Math.sin(rad)) * h) / 2) * (scale / 100);
  const dx = Math.cos(rad) * half, dy = -Math.sin(rad) * half;
  return centred(kind) ? { from: [cx, cy], to: [cx + dx, cy + dy] } : { from: [cx - dx, cy - dy], to: [cx + dx, cy + dy] };
}

// ---- patterns -----------------------------------------------------------------------------------------------------

const isPixels = (v) => !!v && v.width >= 1 && v.height >= 1 && !!v.data;
const isCanvas = (v) => !!v && typeof v.getContext === 'function' && v.width >= 1;

/**
 * The pixels of a stored pattern value (a PatternRef, 0.3's data URL, a runtime canvas or ImageData) for writing:
 * `{ canvas } | { width, height, data } | null`. `resolve(ref)` (the app's `patterns.resolve`, synchronous over the
 * decoded cache) answers for data URLs; a pattern still decoding gives null.
 */
export function patternPixels(value, { resolve = null, canvas = null } = {}) {
  if (isCanvas(canvas)) return { canvas };
  if (isCanvas(value)) return { canvas: value };
  if (isCanvas(value?.canvas)) return { canvas: value.canvas };
  if (isPixels(value)) return { width: value.width, height: value.height, data: value.data };
  if (!value) return null;
  try {
    const px = resolve?.(value);
    if (isPixels(px)) return { width: px.width, height: px.height, data: px.data };
    if (isCanvas(px)) return { canvas: px };
  } catch {
    // an unresolvable reference is reported by the caller
  }
  return null;
}

/**
 * A PSD pattern (PatternInfo, for psd.patterns) for a stored pattern value, or null when its pixels are not at hand.
 * The id is a hash of the pixels (convert.js), so the same pattern on several layers is written once.
 */
export function patternInfoFor(value, opts = {}) {
  const pxs = patternPixels(value, opts);
  if (!pxs) return null;
  const name = (typeof value === 'object' && value?.name) || opts.name || 'Pattern';
  return patternToPsd({ name, ...pxs });
}

/** A PatternRef (with `dataUrl`) for a PSD pattern id read from a file, or null (unknown id, or no DOM to encode). */
export function patternRefForId(id, patterns, { presetId = null } = {}) {
  const info = id ? patterns?.get?.(id) : null;
  if (!info) return null;
  return patternRefFromPsd(info, { presetId });
}

/** Adds PatternInfos to `psd.patterns` once each (by id). */
export function addPatterns(psd, list) {
  if (!list?.length) return;
  psd.patterns = psd.patterns ?? [];
  const have = new Set(psd.patterns.map((p) => p.id));
  for (const p of list) {
    if (!p || have.has(p.id)) continue;
    have.add(p.id);
    psd.patterns.push(p);
  }
}

// ---- vector content (fill layers, shape fills and strokes) <-> Paint (G.2) -----------------------------------------

const GRADIENT_STYLES = ['linear', 'radial', 'angle', 'reflected', 'diamond'];

/**
 * A Pigment Paint for ag-psd vector content (a fill layer's or shape's `vectorFill`, a stroke's `content`).
 * `place`: 'document' (fill layers: the placement becomes document-space from / to over w x h) or 'box' (shapes: angle,
 * scale and offset stay relative to the shape, G.3). Patterns become pixels: a canvas and its data URL (renderer only;
 * in Node, or for a pattern the file does not hold, null with a report).
 */
export function paintFromContent(content, { place = 'document', width = 1, height = 1, patterns = null, profile = null, report = null } = {}) {
  if (!content) return null;
  if (content.type === 'color') return { type: 'solid', color: hexFromPsd(content.color, '#000000', profile) };
  if (content.type === 'pattern') {
    const info = content.id ? patterns?.get?.(content.id) : null;
    const ref = info ? patternRefFromPsd(info) : null;
    if (!ref) {
      report?.(`pattern ${content.name || 'missing'}`);
      return null;
    }
    const pattern = { scale: Number.isFinite(content.scale) ? content.scale : 1, angle: num(content.angle), link: content.linked !== false, origin: content.phase ? [num(content.phase.x), num(content.phase.y)] : [0, 0], name: ref.name, dataUrl: ref.dataUrl };
    // the runtime canvas the pattern renderer draws (a fill layer saves it as patterns/<id>.png)
    pattern.canvas = patternCanvas(info);
    return { type: 'pattern', pattern };
  }
  // a gradient (solid or noise)
  const def = gradientDefFromPsd(content, { interpolation: content.interpolationMethod, profile, report });
  const kind = GRADIENT_STYLES.includes(content.style) ? content.style : 'linear';
  const gradient = { ...def, kind, reverse: !!content.reverse, dither: !!content.dither };
  const angle = num(content.angle, place === 'document' ? 0 : 90), scale = Number.isFinite(content.scale) ? content.scale : 1;
  const offset = content.offset ? [num(content.offset.x) * 100, num(content.offset.y) * 100] : [0, 0];
  if (place === 'document') Object.assign(gradient, fillEnds({ kind, angle, scale: scale * 100, offsetX: offset[0], offsetY: offset[1] }, width, height));
  else Object.assign(gradient, { angle, scale, offset, align: content.align !== false });
  return { type: 'gradient', gradient };
}

/**
 * ag-psd vector content for a Pigment Paint: `{ content, patterns }` (patterns: the PatternInfos it references), or
 * `{ content: null }` when the paint cannot be written (a pattern whose pixels are not loaded; `report` hears why).
 * `place` as in paintFromContent.
 */
export function paintToContent(paint, { place = 'document', width = 1, height = 1, resolve = null, report = null } = {}) {
  if (!paint) return { content: null, patterns: [] };
  if (paint.type === 'solid') return { content: { type: 'color', color: colorToPsd(paint.color ?? '#000000').color }, patterns: [] };
  if (paint.type === 'pattern') {
    const p = paint.pattern ?? {};
    const info = patternInfoFor(p.dataUrl ?? p, { resolve, canvas: p.canvas, name: p.name });
    if (!info) {
      report?.(`pattern ${p.name || ''}`.trim());
      return { content: null, patterns: [] };
    }
    return { content: { type: 'pattern', name: info.name, id: info.id, linked: p.link !== false, phase: { x: num(p.origin?.[0]), y: num(p.origin?.[1]) }, scale: Number.isFinite(p.scale) ? p.scale : 1, angle: num(p.angle) }, patterns: [info] };
  }
  if (paint.type === 'gradient') {
    const g = paint.gradient ?? {};
    const { gradient, interpolation } = gradientDefToPsd(g, { report });
    const kind = GRADIENT_STYLES.includes(g.kind) ? g.kind : 'linear';
    let angle, scale, offset;
    if (place === 'document') {
      const pl = fillPlacement(g, width, height);
      angle = pl.angle;
      scale = pl.scale / 100;
      offset = { x: pl.offsetX / 100, y: pl.offsetY / 100 };
    } else {
      angle = num(g.angle, 90);
      scale = Number.isFinite(g.scale) ? g.scale : 1;
      offset = { x: num(g.offset?.[0]) / 100, y: num(g.offset?.[1]) / 100 };
    }
    return { content: { ...gradient, style: kind, angle, scale, offset, align: g.align !== false, reverse: !!g.reverse, dither: !!g.dither, interpolationMethod: interpolation }, patterns: [] };
  }
  return { content: null, patterns: [] };
}

/** Every '#rrggbb' a paint draws (null for pixels, which a mode document cannot vouch for). */
export function paintColors(paint) {
  if (!paint) return [];
  if (paint.type === 'solid') return [paint.color ?? '#000000'];
  if (paint.type === 'gradient') return normalizeGradient(paint.gradient ?? null).stops.map((s) => (typeof s.color === 'string' ? s.color : null));
  return [null];
}
