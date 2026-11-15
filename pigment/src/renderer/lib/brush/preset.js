// The BrushPreset schema (ARCHITECTURE.md "0.5 features", S1.1). Skeleton file: no package edits it.
//
// One brush preset describes the tip and every Brush Settings section Photoshop has. Sizes are px, angles degrees,
// every other amount a fraction 0..1 (the panel shows percent) unless RANGES says otherwise. normalizeBrush is the one
// place that turns anything (a stored preset, a 0.4 flat object, an .abr import, a replay argument) into a valid
// preset: it never throws, fills defaults, clamps to RANGES and keeps what it does not know in `extras`, so a preset
// from a newer release or an .abr survives a round trip through this one.
//
// Pure: Node tests import it.

export const CONTROL_TYPES = Object.freeze(['off', 'fade', 'pen-pressure', 'pen-tilt', 'stylus-wheel', 'rotation', 'initial-direction', 'direction', 'initial-rotation']);
export const TEXTURE_MODES = Object.freeze(['multiply', 'subtract', 'darken', 'overlay', 'color-dodge', 'color-burn', 'linear-burn', 'hard-mix', 'linear-height', 'height']);
export const DUAL_MODES = Object.freeze(['multiply', 'darken', 'overlay', 'color-dodge', 'color-burn', 'linear-burn', 'hard-mix', 'linear-height']);

/** The panel's sections in order; `toggle`: the section has an enable box (the tip shape is always on). */
export const BRUSH_SECTIONS = Object.freeze([
  { id: 'tip', label: 'Brush Tip Shape', toggle: false },
  { id: 'shapeDynamics', label: 'Shape Dynamics', toggle: true },
  { id: 'scattering', label: 'Scattering', toggle: true },
  { id: 'texture', label: 'Texture', toggle: true },
  { id: 'dualBrush', label: 'Dual Brush', toggle: true },
  { id: 'colorDynamics', label: 'Color Dynamics', toggle: true },
  { id: 'transfer', label: 'Transfer', toggle: true },
  { id: 'brushPose', label: 'Brush Pose', toggle: true },
  { id: 'noise', label: 'Noise', toggle: true },
  { id: 'wetEdges', label: 'Wet Edges', toggle: true },
  { id: 'buildUp', label: 'Build-up', toggle: true },
  { id: 'smoothCurves', label: 'Smoothing', toggle: true },
  { id: 'protectTexture', label: 'Protect Texture', toggle: true },
].map((s) => Object.freeze(s)));

/** The sections that are plain flags on the preset (not objects with `enabled`). */
const FLAG_SECTIONS = ['noise', 'wetEdges', 'buildUp', 'smoothCurves', 'protectTexture'];
const OBJECT_SECTIONS = ['shapeDynamics', 'scattering', 'texture', 'dualBrush', 'colorDynamics', 'transfer', 'brushPose'];

const control = () => ({ type: 'off', fadeSteps: 25 });
const tipDefaults = (size = 24) => ({ kind: 'computed', size, hardness: 0.8, sample: null, angle: 0, roundness: 1, flipX: false, flipY: false, spacing: 0.12, spacingOn: true });

function defaults() {
  return {
    brushVersion: 1,
    tip: tipDefaults(),
    shapeDynamics: { enabled: false, sizeJitter: 0, sizeControl: control(), minimumDiameter: 0, tiltScale: 0, angleJitter: 0, angleControl: control(), roundnessJitter: 0, roundnessControl: control(), minimumRoundness: 0.25, flipXJitter: false, flipYJitter: false, brushProjection: false },
    scattering: { enabled: false, scatter: 0, bothAxes: false, scatterControl: control(), count: 1, countJitter: 0, countControl: control() },
    texture: { enabled: false, pattern: null, invert: false, scale: 1, brightness: 0, contrast: 0, eachTip: false, mode: 'multiply', depth: 1, minimumDepth: 0, depthJitter: 0, depthControl: control() },
    dualBrush: { enabled: false, mode: 'color-burn', flip: false, tip: tipDefaults(25), scatter: 0, bothAxes: false, count: 1, countJitter: 0 },
    colorDynamics: { enabled: false, perTip: true, fbJitter: 0, fbControl: control(), hueJitter: 0, saturationJitter: 0, brightnessJitter: 0, purity: 0 },
    transfer: { enabled: false, opacityJitter: 0, opacityControl: control(), minimumOpacity: 0, flowJitter: 0, flowControl: control(), minimumFlow: 0, wetnessJitter: 0, wetnessControl: control(), mixJitter: 0, mixControl: control() },
    brushPose: { enabled: false, tiltX: 0, tiltY: 0, rotation: 0, pressure: 1, overrideTilt: false, overrideRotation: false, overridePressure: false },
    noise: false,
    wetEdges: false,
    buildUp: false,
    smoothCurves: false,
    protectTexture: false,
    tool: null,
    extras: {},
  };
}

function freezeDeep(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) freezeDeep(v);
  }
  return o;
}

/** Every section at its default, every toggled section off (frozen). */
export const DEFAULT_BRUSH = freezeDeep(defaults());

// ---- ranges -------------------------------------------------------------------------------------------------------

const TIP_RANGES = { size: [1, 5000], hardness: [0, 1], angle: [-180, 180], roundness: [0.01, 1], spacing: [0.01, 10] };
const FRACTION = [0, 1];
/** `{ path: [min, max] }` for every numeric field (fractions 0..1 unless listed otherwise). */
export const RANGES = Object.freeze((() => {
  const r = {};
  for (const [k, v] of Object.entries(TIP_RANGES)) {
    r[`tip.${k}`] = v;
    r[`dualBrush.tip.${k}`] = v;
  }
  const special = {
    'shapeDynamics.tiltScale': [0, 2],
    'scattering.scatter': [0, 10],
    'scattering.count': [1, 16],
    'texture.scale': [0.01, 10],
    'texture.brightness': [-150, 150],
    'texture.contrast': [-50, 100],
    'dualBrush.scatter': [0, 10],
    'dualBrush.count': [1, 16],
    'colorDynamics.purity': [-1, 1],
    'brushPose.tiltX': [-1, 1],
    'brushPose.tiltY': [-1, 1],
    'brushPose.rotation': [0, 360],
  };
  const d = defaults();
  for (const id of OBJECT_SECTIONS) {
    for (const [k, v] of Object.entries(d[id])) if (typeof v === 'number') r[`${id}.${k}`] = special[`${id}.${k}`] ?? FRACTION;
  }
  r['tip.sample.width'] = r['tip.sample.height'] = [1, 10000];
  r['control.fadeSteps'] = [1, 9999];
  return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Object.freeze(v)]));
})());

// ---- normalising --------------------------------------------------------------------------------------------------

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const clamp = (v, [lo, hi]) => Math.min(hi, Math.max(lo, v));
const HEX = /^#[0-9a-f]{6}$/i;

function num(v, def, range) {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  if (!Number.isFinite(n)) return def;
  return range ? clamp(n, range) : n;
}
const bool = (v, def) => (typeof v === 'boolean' ? v : def);

function normalizeControl(c) {
  if (typeof c === 'string') c = { type: c };
  if (!isObject(c)) return control();
  return {
    type: CONTROL_TYPES.includes(c.type) ? c.type : 'off',
    fadeSteps: Math.round(num(c.fadeSteps, 25, RANGES['control.fadeSteps'])),
  };
}

function normalizeSampleRef(s) {
  if (!isObject(s) || typeof s.blob !== 'string' || !s.blob) return null;
  const out = {
    blob: s.blob,
    hash: typeof s.hash === 'string' ? s.hash : '',
    width: Math.round(num(s.width, 1, RANGES['tip.sample.width'])),
    height: Math.round(num(s.height, 1, RANGES['tip.sample.height'])),
  };
  if (typeof s.dataUrl === 'string' && s.dataUrl.startsWith('data:')) out.dataUrl = s.dataUrl;
  return out;
}

function normalizePatternRef(p) {
  if (!isObject(p)) return null;
  if (typeof p.presetId !== 'string' && typeof p.dataUrl !== 'string') return null;
  const out = { presetId: typeof p.presetId === 'string' ? p.presetId : null, name: typeof p.name === 'string' ? p.name : '' };
  if (typeof p.dataUrl === 'string' && p.dataUrl.startsWith('data:')) out.dataUrl = p.dataUrl;
  return out;
}

const TIP_KEYS = ['kind', 'size', 'hardness', 'sample', 'angle', 'roundness', 'flipX', 'flipY', 'spacing', 'spacingOn', 'extras'];

function normalizeTip(t, def) {
  const out = clone(def);
  if (!isObject(t)) return out;
  out.kind = typeof t.kind === 'string' && t.kind ? t.kind : def.kind;
  for (const k of ['size', 'hardness', 'angle', 'roundness', 'spacing']) out[k] = num(t[k], def[k], TIP_RANGES[k]);
  out.sample = normalizeSampleRef(t.sample);
  for (const k of ['flipX', 'flipY', 'spacingOn']) out[k] = bool(t[k], def[k]);
  // a tip kind this release does not know keeps its fields (0.10 adds erodible / bristle / airbrush tips)
  const extras = isObject(t.extras) ? clone(t.extras) : {};
  for (const [k, v] of Object.entries(t)) if (!TIP_KEYS.includes(k)) extras[k] = clone(v);
  if (Object.keys(extras).length) out.extras = extras;
  return out;
}

function normalizeSection(id, src, def, extras) {
  const out = clone(def);
  if (!isObject(src)) return out;
  const unknown = {};
  for (const [k, v] of Object.entries(src)) {
    if (!(k in def)) {
      unknown[k] = clone(v);
      continue;
    }
    const d = def[k];
    if (k === 'tip') out.tip = normalizeTip(v, d);
    else if (k === 'pattern') out.pattern = normalizePatternRef(v);
    else if (k === 'mode') out.mode = (id === 'texture' ? TEXTURE_MODES : DUAL_MODES).includes(v) ? v : d;
    else if (k.endsWith('Control')) out[k] = normalizeControl(v);
    else if (typeof d === 'number') out[k] = num(v, d, RANGES[`${id}.${k}`]);
    else if (typeof d === 'boolean') out[k] = bool(v, d);
  }
  if (id === 'scattering' || id === 'dualBrush') out.count = Math.round(out.count);
  if (Object.keys(unknown).length) extras[id] = { ...(isObject(extras[id]) ? extras[id] : {}), ...unknown };
  return out;
}

function normalizeTool(t) {
  if (!isObject(t)) return null;
  const out = {};
  if (t.opacity !== undefined && Number.isFinite(Number(t.opacity))) out.opacity = clamp(Number(t.opacity), [0.01, 1]);
  if (t.flow !== undefined && Number.isFinite(Number(t.flow))) out.flow = clamp(Number(t.flow), [0.01, 1]);
  if (typeof t.blend === 'string' && t.blend) out.blend = t.blend;
  if (t.smoothing !== undefined && Number.isFinite(Number(t.smoothing))) out.smoothing = clamp(Number(t.smoothing), [0, 1]);
  if (typeof t.color === 'string' && HEX.test(t.color)) out.color = t.color.toLowerCase();
  return Object.keys(out).length ? out : null;
}

const KNOWN = new Set(['brushVersion', 'tip', ...OBJECT_SECTIONS, ...FLAG_SECTIONS, 'tool', 'extras']);

/**
 * Any value to a valid BrushPreset: defaults filled, ranges clamped, unknown keys moved to `extras`. A 0.4 flat
 * object (it has `size` and no `tip`) goes through brushFromLegacy. Never throws.
 */
export function normalizeBrush(any) {
  try {
    if (!isObject(any)) return defaults();
    if (!isObject(any.tip) && 'size' in any) return brushFromLegacy(any);
    const d = defaults();
    const extras = isObject(any.extras) ? clone(any.extras) : {};
    const out = { brushVersion: 1, tip: normalizeTip(any.tip, d.tip) };
    for (const id of OBJECT_SECTIONS) out[id] = normalizeSection(id, any[id], d[id], extras);
    for (const id of FLAG_SECTIONS) out[id] = bool(any[id], false);
    out.tool = normalizeTool(any.tool);
    for (const [k, v] of Object.entries(any)) if (!KNOWN.has(k)) extras[k] = clone(v);
    out.extras = extras;
    return out;
  } catch {
    return defaults();
  }
}

const LEGACY_TIP = ['size', 'hardness', 'spacing', 'angle', 'roundness'];

/**
 * 0.4's flat objects to a preset: its brush presets ({ id, name, size, hardness, spacing, angle, roundness, flow })
 * and its stroke settings. The tip keys go to `tip`; a 0.4 *preset's* flow goes to `tool.flow` (0.4's Brushes panel
 * set the tool's flow on every pick, to 1 when the preset had none), while a stroke's flow stays the stroke's.
 */
export function brushFromLegacy(o) {
  const src = isObject(o) ? o : {};
  const tip = {};
  for (const k of LEGACY_TIP) {
    const n = Number(src[k]);
    if (src[k] !== undefined && src[k] !== null && Number.isFinite(n)) tip[k] = n;
  }
  const isPreset = (typeof src.id === 'string' || typeof src.name === 'string') && !('mode' in src) && !('color' in src) && !('opacity' in src);
  const tool = isPreset ? { flow: Number.isFinite(Number(src.flow)) && src.flow !== null && src.flow !== undefined ? Number(src.flow) : 1 } : null;
  return normalizeBrush({ tip, tool });
}

/** The flat tip keys 0.4 code reads. */
export function legacyTip(preset) {
  const t = preset?.tip ?? DEFAULT_BRUSH.tip;
  return { size: t.size, hardness: t.hardness, spacing: t.spacing, angle: t.angle, roundness: t.roundness };
}

/**
 * S2.2's precedence, the one implementation: `preset = normalizeBrush(settings.preset ?? brushFromLegacy(settings))`,
 * then every flat tip key present overrides `preset.tip`; every other key is a StrokePaint field.
 */
export function splitStrokeSettings(settings) {
  const s = isObject(settings) ? settings : {};
  const preset = normalizeBrush(s.preset ?? brushFromLegacy(s));
  const paint = {};
  for (const [k, v] of Object.entries(s)) {
    if (k === 'preset') continue;
    if (LEGACY_TIP.includes(k)) {
      const n = Number(v);
      if (v !== undefined && v !== null && Number.isFinite(n)) preset.tip[k] = clamp(n, TIP_RANGES[k]);
      continue;
    }
    paint[k] = v;
  }
  return { preset, paint };
}

// ---- comparing and combining ---------------------------------------------------------------------------------

/** A section's value for comparison (sample data URLs are transport, not content). */
function sectionKey(preset, id) {
  const v = preset?.[id];
  return JSON.stringify(v, (k, x) => (k === 'dataUrl' ? undefined : x));
}

export function brushEquals(a, b) {
  const na = normalizeBrush(a), nb = normalizeBrush(b);
  return sectionDiff(na, nb).length === 0 && JSON.stringify(na.tool) === JSON.stringify(nb.tool) && JSON.stringify(na.extras) === JSON.stringify(nb.extras);
}

/** The ids of the sections (BRUSH_SECTIONS) whose values differ: the "modified" marks and the locks. */
export function sectionDiff(a, b) {
  const na = normalizeBrush(a), nb = normalizeBrush(b);
  return BRUSH_SECTIONS.map((s) => s.id).filter((id) => sectionKey(na, id) !== sectionKey(nb, id));
}

/** `base` with the sections `ids` taken from `from` (locks, Copy Texture to Other Tools). */
export function withSections(base, from, ids) {
  const out = normalizeBrush(base);
  const src = normalizeBrush(from);
  for (const id of ids ?? []) if (BRUSH_SECTIONS.some((s) => s.id === id)) out[id] = clone(src[id]);
  return out;
}

/** Clear Brush Controls: every toggled section off, the tip kept. */
export function clearControls(preset) {
  const out = normalizeBrush(preset);
  for (const id of OBJECT_SECTIONS) out[id].enabled = false;
  for (const id of FLAG_SECTIONS) out[id] = false;
  return out;
}

/** The blobs a preset names (in the `brushes` kind): the tip's sample and the dual brush tip's. */
export function blobsOf(preset) {
  const out = [];
  for (const s of [preset?.tip?.sample, preset?.dualBrush?.tip?.sample]) if (s && typeof s.blob === 'string' && !out.includes(s.blob)) out.push(s.blob);
  return out;
}

/** A copy without the samples' data URLs (what the `brushes` kind and settings store). */
export function withoutSampleData(preset) {
  const out = normalizeBrush(preset);
  for (const t of [out.tip, out.dualBrush.tip]) if (t.sample) delete t.sample.dataUrl;
  // a pattern named by its preset needs no pixels; one without a preset id keeps them
  if (out.texture.pattern?.presetId) delete out.texture.pattern.dataUrl;
  return out;
}
