// Layer effects and advanced blending ↔ PSD (ARCHITECTURE.md "0.5 features", S4.3: aspects `advanced-blending` 210
// and `effects` 400; S4.6). psd-layers' file.
//
// Effects: every effect and every instance of the five that have several (Drop Shadow, Inner Shadow, Color Overlay,
// Gradient Overlay, Stroke) both ways, with Photoshop's fields: contours with their corner points, noise, glow
// technique, range, jitter and gradient fills, the Bevel & Emboss Contour and Texture, gradient and pattern
// placement, the Stroke's gradient (Shape Burst included) and pattern fills, Hide All Effects and the effects scale.
// ag-psd parses the lfx2 / lmfx descriptor into its own objects and drops what it has no field for:
// scripts/vendor-entries/ag-psd-layers.js keeps the raw descriptor (`effectsDescriptor`) and merges what this file
// adds (`effectsExtra`) on write, so nothing Pigment draws is lost.
//
// Spread and Choke: Photoshop's are a percentage of Size (the part of the size that is a hard edge before the blur);
// Pigment's are pixels of hard edge added before a blur of Size. Both describe the same two widths, so a Photoshop
// size Z with spread p reads as spread Z·p px and size Z·(1 − p) px, and back.
//
// What Pigment has no form for is approximated (Stroke Emboss reads as Emboss, an HSL noise gradient as HSB) or dropped
// (the Stroke's Overprint, a pattern the file does not hold) and counted in the open notice 'psd-effects', by name.
//
// Advanced blending: Knockout (None / Shallow / Deep), Blend Interior Effects as Group, Blend Clipped Layers as
// Group, Transparency Shapes Layer, Layer Mask Hides Effects, Vector Mask Hides Effects and the channel restriction.
//
// Mode documents (S4.2): while the image mode re-renders colours (Grayscale, Duotone, Multichannel), effects are
// written natively only when every colour they draw is what the document shows (`ctx.asShown`); otherwise they are
// left out, unclaimed, and 0.4's 'styled' notice stays. A channel restriction is not written in such a document
// either (the file is RGB; the restricted channel would colour what the document shows grey).
//
// Node-safe: registry, convert.js, paints.js, document.js and src/shared only.
import { registerPsdAspect, registerPsdFeatures, registerPsdNotice } from './registry.js';
import { psdBlend, toPsdBlend } from './convert.js';
import { hexFromPsd, colorToPsd, unitsToPx, px, gradientDefFromPsd, gradientDefToPsd, legacyStops, patternInfoFor, patternRefForId, addPatterns } from './paints.js';
import { isDefaultBlending, effectiveBlending, DEFAULT_BLENDING } from '../document.js';
import { STYLE_KEYS, INSTANCE_KEYS, effectInstances, hasEnabledStyles, scaleEffects } from '../../../shared/pixels/styles.js';

/** What this file has landed (S15); merged into psdFeatures() by the registry. */
export const PSD_FEATURES = Object.freeze({ effects: true, advancedBlending: true });
registerPsdFeatures(PSD_FEATURES);

const plural = (n, one, many) => (n === 1 ? one : many);
const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const NAMES = Object.fromEntries(STYLE_KEYS.map(({ key, name }) => [key, name]));

// Pigment's effect keys <-> ag-psd's names, and ag-psd's names -> the descriptor keys of one instance and of several
// (the table of ag-psd-layers.js, which a renderer file cannot import)
const AG_NAME = { dropShadow: 'dropShadow', innerShadow: 'innerShadow', outerGlow: 'outerGlow', innerGlow: 'innerGlow', bevel: 'bevel', satin: 'satin', colorOverlay: 'solidFill', gradientOverlay: 'gradientOverlay', patternOverlay: 'patternOverlay', stroke: 'stroke' };
const DESC_KEYS = { dropShadow: ['DrSh', 'dropShadowMulti'], innerShadow: ['IrSh', 'innerShadowMulti'], outerGlow: ['OrGl', null], innerGlow: ['IrGl', null], bevel: ['ebbl', null], solidFill: ['SoFi', 'solidFillMulti'], patternOverlay: ['patternFill', null], gradientOverlay: ['GrFl', 'gradientFillMulti'], satin: ['ChFX', null], stroke: ['FrFX', 'frameFXMulti'] };
const MULTI = new Set(['dropShadow', 'innerShadow', 'solidFill', 'gradientOverlay', 'stroke']);

/** The raw descriptor object of instance `index` of an ag-psd effect, or null. */
function rawOf(desc, agName, index) {
  const [one, many] = DESC_KEYS[agName] ?? [];
  if (!desc || !one) return null;
  if (many && Array.isArray(desc[many])) return desc[many][index] ?? null;
  return index === 0 ? desc[one] ?? null : null;
}

// ---- contours ----------------------------------------------------------------------------------------------------

/** A Pigment Contour from a raw ShpC descriptor ('Crv ' points 0..255, `Cnty` false = a corner) or ag-psd's curve. */
function contourFromPsd(raw, parsed) {
  const pts = Array.isArray(raw?.['Crv ']) ? raw['Crv '].map((p) => ({ x: num(p.Hrzn), y: num(p.Vrtc), corner: p.Cnty === false })) : Array.isArray(parsed?.curve) ? parsed.curve.map((p) => ({ x: num(p.x), y: num(p.y), corner: false })) : [];
  if (pts.length < 2) return null;
  const points = pts.map((p) => ({ x: clamp01(p.x / 255), y: clamp01(p.y / 255), corner: p.corner })).sort((a, b) => a.x - b.x);
  points[0].x = 0;
  points[points.length - 1].x = 1;
  const linear = points.length === 2 && points[0].y === 0 && points[1].y === 1;
  if (linear) return null;
  const name = (typeof raw?.['Nm  '] === 'string' && raw['Nm  ']) || parsed?.name;
  return { ...(name ? { name } : {}), points };
}

/** A raw ShpC descriptor for a Pigment Contour (null: Photoshop's Linear). */
function contourToPsd(contour) {
  const points = Array.isArray(contour?.points) && contour.points.length >= 2 ? contour.points : [{ x: 0, y: 0, corner: false }, { x: 1, y: 1, corner: false }];
  return {
    'Nm  ': contour?.name ?? (contour ? 'Custom' : 'Linear'),
    'Crv ': points.map((p) => ({ Hrzn: Math.round(clamp01(num(p.x)) * 255), Vrtc: Math.round(clamp01(num(p.y)) * 255), ...(p.corner ? { Cnty: false } : {}) })),
  };
}

// ---- reading -----------------------------------------------------------------------------------------------------

const blendFrom = (m, d) => (m ? psdBlend(m) : d);
const pctFrom = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const sizeOf = (v) => Math.max(0, unitsToPx(v));

/** Photoshop's size + spread (percent of size) as Pigment's hard edge (px) and blur (px). */
const splitSpread = (size, spreadPct) => {
  const p = clamp01(num(spreadPct) / 100);
  return { spread: size * p, size: size * (1 - p) };
};

function shadowFrom(e, raw, color) {
  const total = sizeOf(e.size);
  const s = splitSpread(total, unitsToPx(e.choke));
  return {
    enabled: !!e.enabled, blend: blendFrom(e.blendMode, 'multiply'), color: color(e.color, '#000000'), opacity: pctFrom(e.opacity, 0.75),
    angle: num(e.angle, 120), useGlobalLight: !!e.useGlobalLight, distance: sizeOf(e.distance), spread: s.spread, size: s.size,
    contour: contourFromPsd(raw?.TrnS, e.contour), antiAlias: !!e.antialiased, noise: pctFrom(e.noise, 0),
  };
}

function glowFrom(e, raw, color, inner, ctxRead) {
  const total = sizeOf(e.size);
  const s = splitSpread(total, unitsToPx(e.choke));
  const fx = {
    enabled: !!e.enabled, blend: blendFrom(e.blendMode, 'screen'), color: color(e.color, '#ffffbe'), opacity: pctFrom(e.opacity, 0.75),
    technique: e.technique === 'precise' ? 'precise' : 'softer', size: s.size, contour: contourFromPsd(raw?.TrnS, e.contour), antiAlias: !!e.antialiased,
    range: pctFrom(e.range, 0.5), jitter: pctFrom(e.jitter, 0), noise: pctFrom(e.noise, 0),
  };
  if (inner) {
    fx.choke = s.spread;
    fx.source = e.source === 'center' ? 'center' : 'edge';
  } else fx.spread = s.spread;
  if (e.gradient) {
    fx.fill = 'gradient';
    fx.gradient = gradientDefFromPsd(e.gradient, ctxRead);
  } else fx.fill = 'color';
  return fx;
}

const BEVEL_STYLES = { 'inner bevel': 'inner-bevel', 'outer bevel': 'outer-bevel', emboss: 'emboss', 'pillow emboss': 'pillow-emboss' };
const BEVEL_TECH = { smooth: 'smooth', 'chisel hard': 'chisel-hard', 'chisel soft': 'chisel-soft' };

function bevelFrom(e, raw, color, ctxRead, dropped) {
  let style = BEVEL_STYLES[e.style];
  if (!style) {
    style = 'emboss';
    if (e.style === 'stroke emboss') dropped('Bevel & Emboss (Stroke Emboss, read as Emboss)');
  }
  // ag-psd reads the gloss contour ('TrnS') and the Contour element ('MpgS') into one field: the raw descriptor
  // tells them apart
  const gloss = raw ? contourFromPsd(raw.TrnS, null) : contourFromPsd(null, e.contour);
  const shape = raw ? contourFromPsd(raw.MpgS, null) : null;
  const fx = {
    enabled: !!e.enabled, style, technique: BEVEL_TECH[e.technique] ?? 'smooth', depth: Math.round(pctFrom(e.strength, 1) * 1000) / 10,
    direction: e.direction === 'down' ? 'down' : 'up', size: sizeOf(e.size), soften: sizeOf(e.soften), angle: num(e.angle, 120), altitude: num(e.altitude, 30),
    useGlobalLight: !!e.useGlobalLight,
    highlightColor: color(e.highlightColor, '#ffffff'), highlightOpacity: pctFrom(e.highlightOpacity, 0.75), highlightBlend: blendFrom(e.highlightBlendMode, 'screen'),
    shadowColor: color(e.shadowColor, '#000000'), shadowOpacity: pctFrom(e.shadowOpacity, 0.75), shadowBlend: blendFrom(e.shadowBlendMode, 'multiply'),
    glossContour: gloss, antiAlias: !!e.antialiasGloss,
  };
  if (raw?.useShape || shape) fx.contourSub = { enabled: !!raw?.useShape, contour: shape, antiAlias: !!raw?.AntA, range: raw?.Inpr ? clamp01(num(raw.Inpr.value, 50) / 100) : 0.5 };
  if (e.useTexture || e.pattern) {
    const pattern = patternRefForId(e.pattern?.id, ctxRead.patterns);
    if (e.pattern && !pattern) dropped(`Bevel & Emboss Texture (pattern ${e.pattern.name || 'missing'})`);
    fx.texture = {
      enabled: !!e.useTexture && !!pattern, pattern, scale: pctFrom(e.scale, 1), depth: raw?.textureDepth ? num(raw.textureDepth.value, 100) / 100 : 1,
      invert: !!raw?.InvT, link: e.align !== false, origin: e.phase ? [num(e.phase.x), num(e.phase.y)] : [0, 0],
    };
  }
  return fx;
}

function placementFrom(e) {
  return {
    kind: ['linear', 'radial', 'angle', 'reflected', 'diamond'].includes(e.type ?? e.style) ? (e.type ?? e.style) : 'linear',
    angle: num(e.angle, 90), scale: pctFrom(e.scale, 1), offset: e.offset ? [num(e.offset.x) * 100, num(e.offset.y) * 100] : [0, 0],
    align: e.align !== false, reverse: !!e.reverse, dither: !!e.dither,
  };
}

/**
 * Pigment layer styles from ag-psd's `effects` (a layer's `effects`, or one style of an .asl file): `{ styles, report }`.
 * `patterns` maps a PSD pattern id to its PatternInfo (the file's patterns); `descriptor` is the raw lfx2 / lmfx
 * descriptor (`pl.effectsDescriptor`, kept by ag-psd-layers.js) for the fields ag-psd does not parse; `profile` is the
 * document's, for Lab colours. `report` lists what was approximated or dropped, by name. `styles` is null when the
 * record holds no effect.
 */
export function stylesFromPsd(effectsInfo, { patterns = new Map(), descriptor = null, profile = null } = {}) {
  const report = [];
  if (!effectsInfo || typeof effectsInfo !== 'object') return { styles: null, report };
  const dropped = (what) => report.push(what);
  const color = (c, d) => hexFromPsd(c, d, profile);
  const ctxRead = { patterns, profile, report: dropped };
  const list = (v) => (Array.isArray(v) ? v : v ? [v] : []);
  const keep = (e) => e && (e.enabled || e.present !== false);
  const styles = {};
  const put = (key, items) => {
    const fxs = items.filter(Boolean);
    if (!fxs.length) return;
    styles[key] = INSTANCE_KEYS.includes(key) && fxs.length > 1 ? fxs : fxs[0];
  };
  const each = (agName, fn) => list(effectsInfo[agName]).map((e, i) => (keep(e) ? fn(e, rawOf(descriptor, agName, i), i) : null));

  put('dropShadow', each('dropShadow', (e, raw) => ({ ...shadowFrom(e, raw, color), knocksOut: e.layerConceals !== false })));
  put('innerShadow', each('innerShadow', (e, raw) => shadowFrom(e, raw, color)));
  put('outerGlow', each('outerGlow', (e, raw) => glowFrom(e, raw, color, false, ctxRead)));
  put('innerGlow', each('innerGlow', (e, raw) => glowFrom(e, raw, color, true, ctxRead)));
  put('bevel', each('bevel', (e, raw) => bevelFrom(e, raw, color, ctxRead, dropped)));
  put('satin', each('satin', (e, raw) => ({
    enabled: !!e.enabled, blend: blendFrom(e.blendMode, 'multiply'), color: color(e.color, '#000000'), opacity: pctFrom(e.opacity, 0.5), angle: num(e.angle, 19),
    distance: sizeOf(e.distance), size: sizeOf(e.size), invert: e.invert !== false, contour: contourFromPsd(raw?.MpgS, e.contour), antiAlias: !!e.antialiased,
  })));
  put('colorOverlay', each('solidFill', (e) => ({ enabled: !!e.enabled, blend: blendFrom(e.blendMode, 'normal'), color: color(e.color, '#ff0000'), opacity: pctFrom(e.opacity, 1) })));
  put('gradientOverlay', each('gradientOverlay', (e) => {
    const gradient = gradientDefFromPsd(e.gradient, { ...ctxRead, interpolation: e.interpolationMethod });
    return { enabled: !!e.enabled, blend: blendFrom(e.blendMode, 'normal'), opacity: pctFrom(e.opacity, 1), ...placementFrom(e), gradient, stops: legacyStops(gradient) };
  }));
  put('patternOverlay', each('patternOverlay', (e) => {
    const pattern = patternRefForId(e.pattern?.id, patterns);
    if (!pattern) dropped(`Pattern Overlay (pattern ${e.pattern?.name || 'missing'})`);
    return { enabled: !!e.enabled && !!pattern, blend: blendFrom(e.blendMode, 'normal'), opacity: pctFrom(e.opacity, 1), pattern, scale: pctFrom(e.scale, 1), angle: num(e.angle, 0), link: e.align !== false, origin: e.phase ? [num(e.phase.x), num(e.phase.y)] : [0, 0] };
  }));
  put('stroke', each('stroke', (e, raw) => {
    const fx = { enabled: !!e.enabled, size: sizeOf(e.size), position: ['inside', 'center', 'outside'].includes(e.position) ? e.position : 'outside', blend: blendFrom(e.blendMode, 'normal'), opacity: pctFrom(e.opacity, 1), color: color(e.color, '#000000'), fill: 'color' };
    if (e.overprint) dropped('Stroke (Overprint)');
    if (e.fillType === 'gradient' && e.gradient) {
      fx.fill = 'gradient';
      fx.gradient = gradientDefFromPsd(e.gradient, { ...ctxRead, interpolation: e.gradient.interpolationMethod });
      Object.assign(fx, placementFrom(e.gradient));
      if (raw?.Type === 'GrdT.shapeburst' || raw?.Type === 'GrdT.Shpb') fx.kind = 'shape-burst';
    } else if (e.fillType === 'pattern' && e.pattern) {
      const pattern = patternRefForId(e.pattern.id, patterns);
      if (pattern) {
        fx.fill = 'pattern';
        fx.pattern = pattern;
        fx.patternScale = raw?.['Scl '] ? num(raw['Scl '].value, 100) / 100 : 1;
        fx.patternAngle = raw?.Angl ? num(raw.Angl.value, 0) : 0;
        fx.link = e.pattern.linked !== false;
        fx.origin = e.pattern.phase ? [num(e.pattern.phase.x), num(e.pattern.phase.y)] : [0, 0];
      } else dropped(`Stroke (pattern ${e.pattern.name || 'missing'})`);
    }
    return fx;
  }));

  if (!Object.keys(styles).length) return { styles: null, report };
  let out = styles;
  if (effectsInfo.disabled) out.hidden = true;
  // the effects scale (Layer > Layer Style > Scale Effects as Photoshop keeps it): Pigment stores scaled values
  const scale = num(effectsInfo.scale, 1);
  if (scale > 0 && Math.abs(scale - 1) > 1e-6) out = scaleEffects(out, scale);
  return { styles: out, report };
}

// ---- writing -----------------------------------------------------------------------------------------------------

// ag-psd rounds Scale and Offset to whole percents: the floats Photoshop keeps go as raw extras
const floatPlacement = (fx) => ({
  'Scl ': { units: 'Percent', value: num(fx.scale, 1) * 100 },
  Ofst: { Hrzn: { units: 'Percent', value: num(fx.offset?.[0]) }, Vrtc: { units: 'Percent', value: num(fx.offset?.[1]) } },
});
const typedPct = (fraction) => ({ $type: 'UntF', units: 'Percent', value: num(fraction) * 100 });
const typedBool = (v) => ({ $type: 'bool', value: !!v });

/** Every colour an effect instance draws (for asShown in mode documents). */
function colorsOf(key, fx) {
  const out = [];
  const add = (c) => typeof c === 'string' && out.push(c);
  const grad = (g) => g && Array.isArray(g.stops) && g.stops.forEach((s) => add(s.color));
  switch (key) {
    case 'bevel': add(fx.highlightColor ?? '#ffffff'); add(fx.shadowColor ?? '#000000'); break;
    case 'gradientOverlay': grad(fx.gradient ?? { stops: fx.stops }); break;
    case 'patternOverlay': out.push(null); break; // a pattern is pixels: never grey for sure
    case 'stroke':
      if (fx.fill === 'gradient') grad(fx.gradient);
      else if (fx.fill === 'pattern') out.push(null);
      else add(fx.color ?? '#000000');
      break;
    case 'outerGlow':
    case 'innerGlow':
      if (fx.fill === 'gradient') grad(fx.gradient);
      else add(fx.color ?? '#ffffbe');
      break;
    default: add(fx.color ?? (key === 'colorOverlay' ? '#ff0000' : '#000000'));
  }
  return out;
}

/** Pigment's hard edge (px) and blur (px) as Photoshop's size and spread (percent of the size). */
const joinSpread = (spread, size) => {
  const s = Math.max(0, num(spread)), z = Math.max(0, num(size));
  const total = s + z;
  return { size: total, spreadPct: total > 0 ? (s / total) * 100 : 0 };
};

/**
 * ag-psd `effects` for Pigment layer styles: `{ effects, patterns, report, extra }`. `patterns` are the PatternInfos the
 * effects reference (for psd.patterns, or an .asl file's patterns section); `extra` holds the raw descriptor fields
 * ag-psd does not serialise (ag-psd-layers.js merges it as `effectsExtra`); `report` lists what PSD could not hold.
 * ctx: `{ resolvePattern?(ref) }` (the app's `patterns.resolve`, for a pattern held only as a data URL).
 * `effects` is null when the styles hold no effect.
 */
export function stylesToPsd(styles, ctx = {}) {
  const report = [];
  const patterns = [];
  const extra = {};
  if (!styles || typeof styles !== 'object') return { effects: null, patterns, report, extra };
  const resolve = ctx.resolvePattern ?? ctx.app?.patterns?.resolve?.bind(ctx.app.patterns) ?? null;
  const effects = {};
  const put = (agName, list, extras) => {
    if (!list.length) return;
    effects[agName] = MULTI.has(agName) ? list : list[0];
    if (extras.some((x) => x && Object.keys(x).length)) extra[agName] = extras;
  };
  const colorOf = (c, d) => colorToPsd(c ?? d, d);
  const pattern = (ref, what) => {
    const info = patternInfoFor(ref, { resolve });
    if (!info) {
      report.push(`${what} (pattern not loaded)`);
      return null;
    }
    patterns.push(info);
    return { name: info.name, id: info.id };
  };
  const common = (fx) => ({ present: true, showInDialog: true, enabled: !!fx.enabled });

  for (const { key } of STYLE_KEYS) {
    const items = effectInstances(styles, key);
    if (!items.length) continue;
    const agName = AG_NAME[key];
    const list = [], extras = [];
    for (const fx of items) {
      const x = {};
      let e;
      if (key === 'dropShadow' || key === 'innerShadow') {
        const c = colorOf(fx.color, '#000000');
        const s = joinSpread(fx.spread, fx.size ?? 5);
        e = { ...common(fx), blendMode: toPsdBlend(fx.blend ?? 'multiply'), color: c.color, opacity: clamp01(num(fx.opacity, 0.75) * c.alpha), angle: num(fx.angle, 120), useGlobalLight: !!fx.useGlobalLight, distance: px(fx.distance ?? 5), choke: px(s.spreadPct), size: px(s.size), antialiased: !!fx.antiAlias, noise: clamp01(num(fx.noise)) };
        if (key === 'dropShadow') e.layerConceals = fx.knocksOut !== false;
        x.TrnS = contourToPsd(fx.contour);
      } else if (key === 'outerGlow' || key === 'innerGlow') {
        const c = colorOf(fx.color, '#ffffbe');
        const inner = key === 'innerGlow';
        const s = joinSpread(inner ? fx.choke : fx.spread, fx.size ?? 5);
        e = { ...common(fx), blendMode: toPsdBlend(fx.blend ?? 'screen'), opacity: clamp01(num(fx.opacity, 0.75) * (fx.fill === 'gradient' ? 1 : c.alpha)), technique: fx.technique === 'precise' ? 'precise' : 'softer', choke: px(s.spreadPct), size: px(s.size), antialiased: !!fx.antiAlias, range: clamp01(num(fx.range, 0.5)), jitter: clamp01(num(fx.jitter)), noise: clamp01(num(fx.noise)) };
        if (inner) e.source = fx.source === 'center' ? 'center' : 'edge';
        if (fx.fill === 'gradient') {
          const g = gradientDefToPsd(fx.gradient ?? { stops: [{ pos: 0, color: fx.color ?? '#ffffbe', opacity: 1 }, { pos: 1, color: fx.color ?? '#ffffbe', opacity: 0 }] }, { report: (d) => report.push(`${NAMES[key]} (${d})`) });
          e.gradient = g.gradient;
        } else e.color = c.color;
        x.TrnS = contourToPsd(fx.contour);
      } else if (key === 'bevel') {
        const hl = colorOf(fx.highlightColor, '#ffffff'), sh = colorOf(fx.shadowColor, '#000000');
        const style = Object.entries(BEVEL_STYLES).find(([, v]) => v === fx.style)?.[0] ?? 'inner bevel';
        const tech = Object.entries(BEVEL_TECH).find(([, v]) => v === fx.technique)?.[0] ?? 'smooth';
        e = {
          ...common(fx), style, technique: tech, strength: num(fx.depth, 100) / 100, direction: fx.direction === 'down' ? 'down' : 'up', size: px(fx.size ?? 5), soften: px(fx.soften ?? 0),
          angle: num(fx.angle, 120), altitude: num(fx.altitude, 30), useGlobalLight: !!fx.useGlobalLight,
          highlightBlendMode: toPsdBlend(fx.highlightBlend ?? 'screen'), highlightColor: hl.color, highlightOpacity: clamp01(num(fx.highlightOpacity, 0.75) * hl.alpha),
          shadowBlendMode: toPsdBlend(fx.shadowBlend ?? 'multiply'), shadowColor: sh.color, shadowOpacity: clamp01(num(fx.shadowOpacity, 0.75) * sh.alpha),
          antialiasGloss: !!fx.antiAlias,
        };
        x.TrnS = contourToPsd(fx.glossContour);
        const sub = fx.contourSub;
        if (sub && (sub.enabled || sub.contour)) Object.assign(x, { useShape: !!sub.enabled, MpgS: contourToPsd(sub.contour), AntA: !!sub.antiAlias, Inpr: { units: 'Percent', value: Math.round(clamp01(num(sub.range, 0.5)) * 100) } });
        const t = fx.texture;
        if (t && (t.enabled || t.pattern)) {
          const ref = t.pattern ? pattern(t.pattern, 'Bevel & Emboss Texture') : null;
          if (ref) {
            Object.assign(e, { useTexture: !!t.enabled, pattern: ref, scale: num(t.scale, 1), align: t.link !== false, phase: { x: num(t.origin?.[0]), y: num(t.origin?.[1]) } });
            Object.assign(x, { textureDepth: typedPct(num(t.depth, 1)), InvT: typedBool(t.invert) });
          }
        }
      } else if (key === 'satin') {
        const c = colorOf(fx.color, '#000000');
        e = { ...common(fx), blendMode: toPsdBlend(fx.blend ?? 'multiply'), color: c.color, opacity: clamp01(num(fx.opacity, 0.5) * c.alpha), angle: num(fx.angle, 19), distance: px(fx.distance ?? 11), size: px(fx.size ?? 14), invert: fx.invert !== false, antialiased: !!fx.antiAlias };
        x.MpgS = contourToPsd(fx.contour);
      } else if (key === 'colorOverlay') {
        const c = colorOf(fx.color, '#ff0000');
        e = { ...common(fx), blendMode: toPsdBlend(fx.blend ?? 'normal'), color: c.color, opacity: clamp01(num(fx.opacity, 1) * c.alpha) };
      } else if (key === 'gradientOverlay') {
        const g = gradientDefToPsd(fx.gradient ?? { stops: fx.stops ?? [{ pos: 0, color: '#000000' }, { pos: 1, color: '#ffffff' }] }, { report: (d) => report.push(`Gradient Overlay (${d})`) });
        const kind = ['linear', 'radial', 'angle', 'reflected', 'diamond'].includes(fx.kind) ? fx.kind : 'linear';
        e = { ...common(fx), blendMode: toPsdBlend(fx.blend ?? 'normal'), opacity: clamp01(num(fx.opacity, 1)), gradient: g.gradient, interpolationMethod: g.interpolation, type: kind, angle: num(fx.angle, 90), scale: num(fx.scale, 1), offset: { x: num(fx.offset?.[0]) / 100, y: num(fx.offset?.[1]) / 100 }, align: fx.align !== false, reverse: !!fx.reverse, dither: !!fx.dither };
        Object.assign(x, floatPlacement(fx));
      } else if (key === 'patternOverlay') {
        const ref = fx.pattern ? pattern(fx.pattern, 'Pattern Overlay') : null;
        if (!ref) continue;
        e = { ...common(fx), blendMode: toPsdBlend(fx.blend ?? 'normal'), opacity: clamp01(num(fx.opacity, 1)), pattern: ref, scale: num(fx.scale, 1), align: fx.link !== false, phase: { x: num(fx.origin?.[0]), y: num(fx.origin?.[1]) } };
        x['Scl '] = { units: 'Percent', value: num(fx.scale, 1) * 100 };
        // ag-psd writes a Pattern Overlay's angle under the shadows' key: Photoshop's is 'Angl'
        x.Angl = { units: 'Angle', value: num(fx.angle) };
      } else if (key === 'stroke') {
        const c = colorOf(fx.color, '#000000');
        e = { ...common(fx), size: px(fx.size ?? 3), position: ['inside', 'center', 'outside'].includes(fx.position) ? fx.position : 'outside', blendMode: toPsdBlend(fx.blend ?? 'normal'), opacity: clamp01(num(fx.opacity, 1) * (fx.fill === 'color' || !fx.fill ? c.alpha : 1)), fillType: 'color', color: c.color };
        if (fx.fill === 'gradient') {
          const g = gradientDefToPsd(fx.gradient, { report: (d) => report.push(`Stroke (${d})`) });
          const shape = fx.kind === 'shape-burst';
          e.fillType = 'gradient';
          e.gradient = { ...g.gradient, style: shape ? 'linear' : (['linear', 'radial', 'angle', 'reflected', 'diamond'].includes(fx.kind) ? fx.kind : 'linear'), angle: num(fx.angle, 90), scale: num(fx.scale, 1), offset: { x: num(fx.offset?.[0]) / 100, y: num(fx.offset?.[1]) / 100 }, align: fx.align !== false, reverse: !!fx.reverse, dither: !!fx.dither, interpolationMethod: g.interpolation };
          Object.assign(x, floatPlacement(fx));
          if (shape) x.Type = 'GrdT.shapeburst';
        } else if (fx.fill === 'pattern') {
          const ref = fx.pattern ? pattern(fx.pattern, 'Stroke') : null;
          if (ref) {
            e.fillType = 'pattern';
            // ag-psd's writer cannot write its own 'Lnkd' boolean: the flag goes as a typed extra
            e.pattern = { ...ref, phase: { x: num(fx.origin?.[0]), y: num(fx.origin?.[1]) } };
            x.Lnkd = typedBool(fx.link !== false);
            x['Scl '] = { units: 'Percent', value: num(fx.patternScale, 1) * 100 };
            x.Angl = { units: 'Angle', value: num(fx.patternAngle) };
          }
        }
      }
      if (!e) continue;
      list.push(e);
      extras.push(x);
    }
    put(agName, list, extras);
  }
  if (!Object.keys(effects).length) return { effects: null, patterns, report, extra };
  effects.scale = 1;
  if (styles.hidden === true) effects.disabled = true;
  return { effects, patterns, report, extra };
}

/**
 * The raw lfx2 descriptor object for ag-psd `effects` and `extra` (for an .asl writer): ag-psd's serializeEffects with
 * the extra fields merged. `serializeEffects` is the '#ag-psd' internal; values of a key ag-psd's writer does not
 * type (`{ $type, … }`) are left out unless `typed` (only ag-psd-layers.js can write those).
 */
export function effectsDescriptor(serializeEffects, effects, extra, { typed = false } = {}) {
  const desc = serializeEffects(effects, false, true);
  for (const [agName, patches] of Object.entries(extra ?? {})) {
    const [one, many] = DESC_KEYS[agName] ?? [];
    const objs = many && Array.isArray(effects?.[agName]) && effects[agName].length > 1 ? desc[many] : desc[one] ? [desc[one]] : [];
    patches.forEach((patch, i) => {
      const obj = objs?.[i];
      if (!obj || !patch) return;
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined || (!typed && v && typeof v === 'object' && v.$type)) delete obj[k];
        else obj[k] = v;
      }
    });
  }
  return desc;
}

// ---- the effects aspect (400) ---------------------------------------------------------------------------------------

registerPsdNotice('psd-effects', {
  when: 'open',
  timeout: 6000,
  text: (n, details) => {
    const names = [...new Set(details)];
    return `${n} layer effect setting${plural(n, '', 's')} Pigment does not have ${plural(n, 'was', 'were')} approximated or dropped: ${names.join(', ')}`;
  },
});
registerPsdNotice('psd-effects-save', {
  when: 'save',
  timeout: 5000,
  text: (n, details) => `${n} layer effect setting${plural(n, '', 's')} PSD cannot hold ${plural(n, 'was', 'were')} changed or left out: ${[...new Set(details)].join(', ')}`,
});

const hasAnyEffect = (styles) => !!styles && typeof styles === 'object' && STYLE_KEYS.some(({ key }) => effectInstances(styles, key).length > 0);

registerPsdAspect({
  id: 'effects',
  order: 400,
  read(pl, layer, ctx) {
    if (!pl.effects) return;
    const { styles, report } = stylesFromPsd(pl.effects, { patterns: ctx.patterns, descriptor: pl.effectsDescriptor ?? null, profile: ctx.doc?.profile ?? null });
    for (const r of report) ctx.report.add('psd-effects', r);
    if (styles) {
      layer.styles = styles;
      ctx.claim(layer, 'effects');
    }
  },
  write(layer, rec, ctx) {
    const styles = layer.styles;
    if (!hasAnyEffect(styles)) return;
    // a mode document: native only when every colour drawn is what the mode shows
    if (ctx.modeRendered && hasEnabledStyles(styles)) {
      for (const { key } of STYLE_KEYS) for (const fx of effectInstances(styles, key)) if (fx.enabled && colorsOf(key, fx).some((c) => !c || !ctx.asShown(c))) return;
    }
    const app = ctx.doc?.view?.app ?? null;
    const { effects, patterns, report, extra } = stylesToPsd(styles, { app });
    if (!effects) return;
    rec.effects = effects;
    if (Object.keys(extra).length) rec.effectsExtra = extra;
    addPatterns(ctx.psd, patterns);
    for (const r of report) ctx.report.add('psd-effects-save', r);
    ctx.claim(layer, 'effects');
  },
});

// ---- advanced blending (210) -----------------------------------------------------------------------------------------

const KNOCKOUTS = ['none', 'shallow', 'deep'];

/** The advanced blending fields (no Blend If) of a layer's blending as ag-psd layer fields, or null when all default. */
export function advancedBlendingToPsd(blending) {
  if (isDefaultBlending(blending ? { ...blending, blendIf: null } : null)) return null;
  const b = effectiveBlending({ blending });
  const restricted = ['r', 'g', 'b'].map((c, i) => (b.channels?.[c] === false ? i : -1)).filter((i) => i >= 0);
  const out = {
    knockout: b.knockout !== 'none',
    knockoutMode: KNOCKOUTS.includes(b.knockout) ? b.knockout : 'none',
    blendInteriorElements: !!b.interiorAsGroup,
    blendClippendElements: b.clippedAsGroup !== false,
    transparencyShapesLayer: b.transparencyShapes !== false,
    layerMaskAsGlobalMask: !!b.maskHidesEffects,
    vectorMaskAsGlobalMask: !!b.vectorMaskHidesEffects,
  };
  if (restricted.length) out.channelBlendingRestrictions = restricted;
  return out;
}

/** Pigment's blending fields (no Blend If) from an ag-psd layer record; only those that differ from the defaults. */
export function advancedBlendingFromPsd(pl) {
  const d = DEFAULT_BLENDING;
  const out = {};
  const knockout = KNOCKOUTS.includes(pl.knockoutMode) ? pl.knockoutMode : pl.knockout ? 'shallow' : 'none';
  if (knockout !== d.knockout) out.knockout = knockout;
  if (pl.blendInteriorElements !== undefined && !!pl.blendInteriorElements !== d.interiorAsGroup) out.interiorAsGroup = !!pl.blendInteriorElements;
  if (pl.blendClippendElements !== undefined && !!pl.blendClippendElements !== d.clippedAsGroup) out.clippedAsGroup = !!pl.blendClippendElements;
  if (pl.transparencyShapesLayer !== undefined && !!pl.transparencyShapesLayer !== d.transparencyShapes) out.transparencyShapes = !!pl.transparencyShapesLayer;
  if (pl.layerMaskAsGlobalMask !== undefined && !!pl.layerMaskAsGlobalMask !== d.maskHidesEffects) out.maskHidesEffects = !!pl.layerMaskAsGlobalMask;
  if (pl.vectorMaskAsGlobalMask !== undefined && !!pl.vectorMaskAsGlobalMask !== d.vectorMaskHidesEffects) out.vectorMaskHidesEffects = !!pl.vectorMaskAsGlobalMask;
  const r = Array.isArray(pl.channelBlendingRestrictions) ? pl.channelBlendingRestrictions : [];
  if (r.some((i) => i >= 0 && i <= 2)) out.channels = { r: !r.includes(0), g: !r.includes(1), b: !r.includes(2) };
  return out;
}

registerPsdAspect({
  id: 'advanced-blending',
  order: 210,
  read(pl, layer, ctx) {
    const fields = advancedBlendingFromPsd(pl);
    if (!Object.keys(fields).length) return;
    // Blend If (200) may already be there
    layer.blending = { ...(layer.blending ?? {}), ...fields };
    ctx.claim(layer, 'advanced-blending');
  },
  write(layer, rec, ctx) {
    const fields = advancedBlendingToPsd(layer.blending);
    if (!fields) return;
    // the file is RGB: a restricted channel would colour what a Grayscale, Duotone or Multichannel document shows grey
    if (ctx.modeRendered && fields.channelBlendingRestrictions) return;
    Object.assign(rec, fields);
    ctx.claim(layer, 'advanced-blending');
  },
});
