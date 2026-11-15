// The brush engine (ARCHITECTURE.md "0.5 features", S2). brush-engine-core's file; this is the skeleton's stub: 0.4's
// BrushStroke moved verbatim from lib/brush.js (its `migrate` from tools/paint.js, now a method) plus the 0.5 hooks:
//   - S2.2: settings in the one form (0.4's flat object, optionally with `preset`), split by splitStrokeSettings;
//     partial samples filled by normalizeSample; begin() again within a stroke starts a sub-path; finish(); tick().
//   - S2.3: traceDabs, the pure dab trace of a whole stroke (the placement code below is shared with BrushStroke, so
//     the trace and the painted stroke cannot drift apart).
//   - S2.4: the modifier chain: `sample` on each input sample, `geometry` on every dab, `coverage` through a scratch
//     canvas read back and written back, `buffer` on a copy of the flushed rect; each only while a modifier of that
//     stage is enabled for the stroke. With nothing enabled the 0.4 path runs unchanged (the goldens hold exactly).
//   - S2.6: tip kinds, tipOutline (an ellipse), renderTip (dabCanvas), strokeReach (the tip size, 0.4's growth margin,
//     plus every enabled modifier's reach) and renderStrokePreview (a real stroke on an offscreen canvas).
// Callers import from lib/brush.js (the facade), never from this file. Node-safe at import time (traceDabs and the
// registries run in Node tests); canvases are created only when a stroke paints.
import { CANVAS_BLEND, blendImages } from '../../../shared/pixels/blend.js';
import { parseColor, rgbaToHex } from '../../../shared/pixels/color.js';
import { createCanvas } from '../document.js';
import { dabCanvas, dabDiameter, dabDrawSide } from '../brush.js';
import { splitStrokeSettings, normalizeBrush } from './preset.js';
import { sampleCanvas } from './tool-brush.js';

/** What this engine is (S15: brush-engine-core has landed when the id is not 'classic-0.4'). */
export const ENGINE = Object.freeze({
  id: 'classic-0.4',
  version: 1,
  features: Object.freeze({ dynamics: false, sampledTips: false, buildUp: false, smoothingModes: false, smoothCurves: false, tilt: false, modifiersFor: Object.freeze([]) }),
});

// ---- pointer samples (S2.2, S2.5) -------------------------------------------------------------------------------

/**
 * A full PointerSample from a partial one: pressure 1, tilt 0, twist 0, wheel 0, pointerType 'mouse'; time is
 * prev.time + 1 ms per px travelled (0 for the first) when the sample has none.
 */
export function normalizeSample(partial, prev = null) {
  const p = partial && typeof partial === 'object' ? partial : {};
  const x = Number(p.x) || 0, y = Number(p.y) || 0;
  const tiltX = Number(p.tiltX) || 0, tiltY = Number(p.tiltY) || 0;
  let altitude = p.altitude, azimuth = p.azimuth;
  if (!Number.isFinite(altitude) || !Number.isFinite(azimuth)) {
    // the Pointer Events spec's conversion from tilt
    const tx = Math.tan((tiltX * Math.PI) / 180), ty = Math.tan((tiltY * Math.PI) / 180);
    const r = Math.hypot(tx, ty);
    altitude = r === 0 ? Math.PI / 2 : Math.atan(1 / r);
    azimuth = r === 0 ? 0 : (Math.atan2(ty, tx) + Math.PI * 2) % (Math.PI * 2);
  }
  const time = Number.isFinite(p.time) ? p.time : prev ? prev.time + Math.hypot(x - prev.x, y - prev.y) : 0;
  return {
    screenX: x, screenY: y, buttons: 1, button: 0, shift: false, alt: false, ctrl: false, meta: false, capsLock: false, temporary: null,
    eraser: false, barrel: false,
    ...p,
    x, y,
    pressure: p.pressure ?? 1,
    tiltX, tiltY,
    twist: Number(p.twist) || 0,
    tangentialPressure: Number(p.tangentialPressure) || 0,
    altitude, azimuth,
    pointerType: p.pointerType ?? 'mouse',
    time,
  };
}

// ---- modifiers (S2.4) and tip kinds (S2.6) ----------------------------------------------------------------------

const MODIFIERS = new Map();

/** Registers a dab modifier (the same id: the later registration wins). Returns an unregister function. */
export function registerDabModifier(mod) {
  if (!mod || typeof mod.id !== 'string') throw new Error('A dab modifier needs an id');
  MODIFIERS.set(mod.id, mod);
  return () => {
    if (MODIFIERS.get(mod.id) === mod) MODIFIERS.delete(mod.id);
  };
}

/** The registered modifiers, in order. */
export function dabModifiers() {
  return [...MODIFIERS.values()].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

function enabledFor(mod, preset, paint) {
  try {
    return !!mod.enabled?.(preset, paint);
  } catch (err) {
    console.warn(`dab modifier ${mod.id} failed`, err);
    return false;
  }
}

/** The modifiers that run for a stroke: the registered ones and the stroke's own, enabled, in order. */
function strokeModifiers(extra, preset, paint) {
  const byId = new Map(dabModifiers().map((m) => [m.id, m]));
  for (const m of extra ?? []) if (m?.id) byId.set(m.id, m);
  return [...byId.values()].filter((m) => enabledFor(m, preset, paint)).sort((a, b) => (a.order ?? 0) - (b.order ?? 0)).map((mod) => ({ mod, state: undefined }));
}

const TIP_KINDS = new Map();

/** A tip kind: render(tip, size) → canvas with the coverage in alpha; outline(tip, o) → polygons around (0, 0). */
export function registerTipKind(kind, def) {
  TIP_KINDS.set(kind, def);
}

/** The tip's outline as polygons around (0, 0) in px (the cursor's shape). Stub: an ellipse. */
export function tipOutline(tip, { size = tip?.size ?? 24, angle = tip?.angle ?? 0, roundness = tip?.roundness ?? 1, flipX = false, flipY = false } = {}) {
  const kind = TIP_KINDS.get(tip?.kind);
  if (kind?.outline) return kind.outline(tip, { size, angle, roundness, flipX, flipY });
  const rx = size / 2, ry = (size / 2) * Math.max(0.01, Math.min(1, roundness));
  const a = (angle * Math.PI) / 180, ca = Math.cos(a), sa = Math.sin(a);
  const n = Math.max(16, Math.min(96, Math.round(size)));
  const pts = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    let x = Math.cos(t) * rx, y = Math.sin(t) * ry;
    if (flipX) x = -x;
    if (flipY) y = -y;
    pts.push([x * ca - y * sa, x * sa + y * ca]);
  }
  return [pts];
}

/** A tip's image for thumbnails: coverage painted in `color`. Stub: dabCanvas (a decoded sampled tip: its sample). */
export function renderTip(tip, size, color = '#000') {
  const kind = TIP_KINDS.get(tip?.kind);
  if (kind?.render) return tinted(kind.render(tip, size), color);
  if (tip?.kind === 'sampled') {
    const s = sampleDab(tip, size, color);
    if (s) return atDrawSide(s, size);
  }
  return atDrawSide(dabCanvas(size, tip?.hardness ?? 0.8, color), size);
}

/** A cached dab canvas at the side it is drawn at (S2.8: the cache may hold a larger one); a copy only when it differs. */
function atDrawSide(c, size) {
  const side = dabDrawSide(size);
  if (c.width === side && c.height === side) return c;
  const out = createCanvas(side, side);
  out.getContext('2d').drawImage(c, 0, 0, side, side);
  return out;
}

/**
 * How far from the pointer a dab can put pixels (px): what a lazily grown layer grows by. Stub: the tip size (0.4's
 * growth margin) plus the reach of every enabled modifier.
 */
export function strokeReach(preset, paint = {}) {
  const p = preset?.tip ? preset : normalizeBrush(preset);
  let r = p.tip.size;
  for (const mod of dabModifiers()) {
    if (typeof mod.reach !== 'function' || !enabledFor(mod, p, paint)) continue;
    try {
      r += Math.max(0, Number(mod.reach(p, paint)) || 0);
    } catch (err) {
      console.warn(`dab modifier ${mod.id} reach failed`, err);
    }
  }
  return r;
}

// ---- tips ---------------------------------------------------------------------------------------------------------

function tinted(coverage, color) {
  if (!coverage) return null;
  const c = createCanvas(coverage.width, coverage.height);
  const ctx = c.getContext('2d');
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.globalCompositeOperation = 'destination-in';
  ctx.drawImage(coverage, 0, 0);
  return c;
}

// bounded by the pixels it holds and keyed on dabCanvas's 1 % size steps, as dabCanvas's own cache (S2.8)
const sampleCache = new Map();
const SAMPLE_CACHE_PIXELS = 64 * 1024 * 1024;
let sampleCachePixels = 0;
/**
 * A decoded sampled tip (lib/brush/tool-brush.js sampleCanvas: coverage in alpha) scaled to `size`, in `color`. Like
 * dabCanvas it may be larger than asked above 128 px: draw it at dabDrawSide(size).
 */
function sampleDab(tip, size, color) {
  const id = tip?.sample?.hash || tip?.sample?.blob;
  const src = id ? sampleCanvas(id) : null;
  if (!src) return null;
  const d = dabDiameter(size);
  const key = `${id}|${d}|${color}`;
  let c = sampleCache.get(key);
  if (c) return c;
  // the longer side of the sample is the diameter
  const k = d / Math.max(src.width, src.height);
  const w = Math.max(1, Math.round(src.width * k)), h = Math.max(1, Math.round(src.height * k));
  const pad = 1;
  c = createCanvas(d + pad * 2, d + pad * 2);
  const ctx = c.getContext('2d');
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.globalCompositeOperation = 'destination-in';
  ctx.drawImage(src, pad + (d - w) / 2, pad + (d - h) / 2, w, h);
  const px = c.width * c.height;
  while (sampleCache.size && sampleCachePixels + px > SAMPLE_CACHE_PIXELS) {
    const [k, old] = sampleCache.entries().next().value;
    sampleCache.delete(k);
    sampleCachePixels -= old.width * old.height;
  }
  sampleCache.set(key, c);
  sampleCachePixels += px;
  return c;
}

// ---- placement (shared by BrushStroke and traceDabs) -------------------------------------------------------------

/** 0.4's merged settings view: its defaults, the flat settings, the tip keys from the preset where the flat ones are absent. */
function strokeView(settings, preset) {
  const { preset: _p, ...flat } = settings ?? {};
  const t = preset.tip;
  return {
    spacing: 0.12, smoothing: 0.2, blend: 'normal', mode: 'paint', antialias: true,
    ...flat,
    size: flat.size ?? t.size,
    hardness: flat.hardness ?? t.hardness,
    spacing: flat.spacing ?? t.spacing,
    angle: flat.angle ?? t.angle,
    roundness: flat.roundness ?? t.roundness,
  };
}

function effectiveSize(s, pressure) {
  const base = s.size;
  if (s.pressureSize && pressure !== undefined && pressure !== 1) return Math.max(1, base * Math.max(0.05, pressure));
  return base;
}

function dabFlow(s, pressure) {
  let flow = s.flow;
  if (s.pressureOpacity && pressure !== undefined) flow *= Math.max(0.05, pressure);
  return flow;
}

/** begin: the first dab of a (sub-)path at p (stroke-canvas px). */
function placeBegin(st, p, emit) {
  st.smoothed = { x: p.x, y: p.y };
  st.last = { x: p.x, y: p.y, pressure: p.pressure };
  emit(p.x, p.y, p.pressure);
}

/** extend: smoothing, then dabs every `step` along the segment (0.4's code). False when the pointer did not move. */
function placeExtend(st, raw, emit) {
  const k = 1 - Math.min(0.95, Math.max(0, st.s.smoothing));
  st.smoothed = { x: st.smoothed.x + (raw.x - st.smoothed.x) * k, y: st.smoothed.y + (raw.y - st.smoothed.y) * k };
  const p = { x: st.smoothed.x, y: st.smoothed.y, pressure: raw.pressure };
  const size = effectiveSize(st.s, p.pressure);
  const step = Math.max(0.5, size * st.s.spacing);
  const dx = p.x - st.last.x, dy = p.y - st.last.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 1e-3) return false;
  const nx = dx / dist, ny = dy / dist;
  let travelled = 0;
  // place dabs every `step` along the segment, carrying the leftover from the previous segment
  let first = step - st.distance;
  if (first <= 0) first = step;
  for (let t = first; t <= dist; t += step) {
    const u = t / dist;
    const pr = st.last.pressure + (p.pressure - st.last.pressure) * u;
    emit(st.last.x + nx * t, st.last.y + ny * t, pr);
    travelled = t;
  }
  // carry the distance since the last dab across segments that placed none (slow strokes)
  st.distance = travelled > 0 ? dist - travelled : st.distance + dist;
  st.last = { x: p.x, y: p.y, pressure: p.pressure };
  return true;
}

function seededRandom(seed, salt) {
  let h = 2166136261 >>> 0;
  for (const ch of `${seed}:${salt}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  let a = h || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// a stroke without paint.seed gets its own (S2.4), so two strokes do not repeat one jitter sequence
let strokeCount = 0;
function nextStrokeSeed() {
  strokeCount = (strokeCount + 1) >>> 0;
  return ((Date.now() ^ Math.imul(strokeCount, 0x9e3779b9)) >>> 0) || 1;
}

/**
 * S2.4: the engine fills what paint lacks. `seed` (traceDabs: its option, default 1; a stroke: a fresh one per stroke);
 * `constrainColor` (S2.7): paint's own, else app.colorConstraint (hex in, hex out) applied to the rgb, else identity.
 * `app` comes from paint.view, else paint.app (renderStrokePreview passes it, so previews resolve ctx.patterns).
 */
function strokeContext({ preset, paint, stroke = null, layer = null, seed = paint.seed ?? 1 }) {
  const app = paint.view?.app ?? paint.app ?? null;
  const doc = paint.view?.doc ?? app?.doc ?? null;
  let constrainColor = (rgb) => rgb;
  if (typeof paint.constrainColor === 'function') constrainColor = paint.constrainColor;
  else if (typeof app?.colorConstraint === 'function') {
    constrainColor = (rgb) => {
      const hex = app.colorConstraint(rgbaToHex(rgb), doc);
      return typeof hex === 'string' ? parseColor(hex).slice(0, 3) : rgb;
    };
  }
  return {
    preset, paint, stroke, layer, app, doc,
    random: (salt) => seededRandom(seed, salt),
    constrainColor,
    patterns: app?.patterns ?? null,
  };
}

function runModifierHook(m, name, args) {
  try {
    return m.mod[name](...args);
  } catch (err) {
    console.warn(`dab modifier ${m.mod.id} ${name} failed`, err);
    return undefined;
  }
}

function dabColor(s) {
  if (s.mode === 'mask') return [255, 255, 255];
  if (s.mode === 'erase') return [0, 0, 0];
  const [r, g, b] = parseColor(s.color);
  return [r, g, b];
}

/** The dabs a geometry stage makes of one placed dab (itself when no geometry modifier runs). */
function geometryDabs(dab, mods, ctx) {
  let list = [dab];
  for (const m of mods) {
    if (typeof m.mod.geometry !== 'function') continue;
    const next = [];
    for (const d of list) {
      const r = runModifierHook(m, 'geometry', [d, m.state, ctx]);
      if (Array.isArray(r)) next.push(...r);
      else next.push(d);
    }
    list = next;
  }
  return list;
}

/** Runs the `buffer` stage on straight-alpha RGBA of the accumulated stroke inside rect (exported for tests). */
export function runBufferModifiers(img, rect, mods, ctx) {
  for (const m of mods) if (typeof m.mod.buffer === 'function') runModifierHook(m, 'buffer', [img, rect, m.state, ctx]);
  return img;
}

/**
 * The dabs of a whole stroke, without pixels or timers (S2.3): sample stages, placement, smoothing and the geometry
 * stage. `{ break: true }` starts a sub-path; with `finish`, the last sample is also the release point (0.4's
 * onPointerUp extend, without smoothing), as a pointer's last move and its release are.
 */
export function traceDabs(samples, settings, { seed = 1, finish = true, modifiers = [] } = {}) {
  const { preset, paint } = splitStrokeSettings({ ...(settings ?? {}), seed: settings?.seed ?? seed });
  const s = strokeView(settings, preset);
  const st = { s, last: null, smoothed: null, distance: 0 };
  const mods = strokeModifiers(modifiers, preset, paint);
  const ctx = strokeContext({ preset, paint });
  for (const m of mods) if (typeof m.mod.begin === 'function') m.state = runModifierHook(m, 'begin', [ctx]);
  const out = [];
  const color = dabColor(s);
  let t0 = null, current = null, index = 0;
  const emit = (x, y, pressure) => {
    const prevDab = out[out.length - 1];
    const direction = prevDab ? (Math.atan2(y - prevDab.y, x - prevDab.x) * 180) / Math.PI : 0;
    const dab = { x, y, pressure, size: effectiveSize(s, pressure), angle: s.angle ?? 0, roundness: s.roundness ?? 1, flipX: preset.tip.flipX, flipY: preset.tip.flipY, opacity: 1, flow: dabFlow(s, pressure), color: color.slice(), tip: preset.tip, index: index++, t: current.time - t0, sample: current, direction, seed: paint.seed ?? seed };
    out.push(...geometryDabs(dab, mods, ctx));
  };
  const input = (raw) => {
    let smp = normalizeSample(raw, current);
    for (const m of mods) if (typeof m.mod.sample === 'function') smp = runModifierHook(m, 'sample', [smp, m.state, ctx]) ?? smp;
    if (t0 === null) t0 = smp.time;
    current = smp;
    return smp;
  };
  let started = false, newPath = false, last = null;
  for (const raw of samples ?? []) {
    if (raw?.break) {
      newPath = true;
      continue;
    }
    const smp = input(raw);
    last = raw;
    const p = { x: smp.x, y: smp.y, pressure: smp.pressure };
    if (!started || newPath) {
      placeBegin(st, p, emit);
      started = true;
      newPath = false;
    } else placeExtend(st, p, emit);
  }
  if (finish && last && started) {
    const smp = input(last);
    const smoothing = s.smoothing;
    s.smoothing = 0;
    placeExtend(st, { x: smp.x, y: smp.y, pressure: smp.pressure }, emit);
    s.smoothing = smoothing;
  }
  for (const m of mods) if (typeof m.mod.end === 'function') runModifierHook(m, 'end', [m.state, ctx]);
  return out;
}

// ---- the stroke -----------------------------------------------------------------------------------------------

/**
 * One brush stroke (S2.2).
 * target: { canvas, x, y, mask? } (document offset of the canvas), layer (for history/touch), settings: 0.4's flat
 * object { size, hardness, opacity, flow, spacing, smoothing, angle, roundness, pressureSize, pressureOpacity, blend,
 * color, mode: 'paint'|'erase'|'mask', maskValue, antialias, ... }, optionally with `preset` (a BrushPreset).
 */
export class BrushStroke {
  constructor({ target, layer, settings, selection = null, history, onDirty, modifiers = [] }) {
    this.target = target;
    this.layer = layer;
    const { preset, paint } = splitStrokeSettings(settings);
    this.preset = preset;
    this.paint = paint;
    this.s = strokeView(settings, preset);
    this.selection = selection;
    this.history = history;
    this.onDirty = onDirty;
    this.canvas = target.canvas;
    this.buffer = createCanvas(this.canvas.width, this.canvas.height);
    this.bctx = this.buffer.getContext('2d');
    this.backup = history.beginStroke(this.canvas, { label: settings.label ?? 'Brush', layer, kind: target.mask ? 'mask' : 'pixels' }).backup;
    this.last = null; // last dab position (canvas coords)
    this.smoothed = null;
    this.distance = 0;
    this.dirty = null;
    this.frameDirty = null;
    this.rafPending = false;
    this.ended = false;
    this.dabs = 0;
    this.leash = null; // pulled-string smoothing (brush-engine-core); the stub smooths by averaging
    this.t0 = null;
    this.current = null;
    this.mods = strokeModifiers(modifiers, preset, paint);
    this.seed = paint.seed ?? nextStrokeSeed();
    this.ctx = strokeContext({ preset, paint, stroke: this, layer, seed: this.seed });
    for (const m of this.mods) if (typeof m.mod.begin === 'function') m.state = runModifierHook(m, 'begin', [this.ctx]);
    this.sampleMods = this.mods.filter((m) => typeof m.mod.sample === 'function');
    this.geometryMods = this.mods.filter((m) => typeof m.mod.geometry === 'function');
    this.coverageMods = this.mods.filter((m) => typeof m.mod.coverage === 'function');
    this.bufferMods = this.mods.filter((m) => typeof m.mod.buffer === 'function');
    this.emit = (x, y, pressure) => this.dab(x, y, pressure);
    this.tipWarned = false;
  }

  get composite() {
    const { mode, blend } = this.s;
    if (mode === 'erase') return 'destination-out';
    return CANVAS_BLEND[blend] ?? 'source-over';
  }

  /** Converts a document point to canvas-local coordinates. */
  local(p) {
    return { x: p.x - this.target.x, y: p.y - this.target.y, pressure: p.pressure ?? 1 };
  }

  /** An input sample: filled (normalizeSample) and through the modifiers' `sample` stage. */
  input(point) {
    let smp = normalizeSample(point, this.current);
    for (const m of this.sampleMods) smp = runModifierHook(m, 'sample', [smp, m.state, this.ctx]) ?? smp;
    if (this.t0 === null) this.t0 = smp.time;
    this.current = smp;
    return smp;
  }

  /** The first dab; again within a stroke: a new sub-path (position and smoothing reset, the entry kept). */
  begin(point) {
    placeBegin(this, this.local(this.input(point)), this.emit);
    this.schedule();
  }

  extend(point) {
    if (this.ended) return;
    if (placeExtend(this, this.local(this.input(point)), this.emit)) this.schedule();
  }

  /** Extends to the release point without smoothing (0.4's onPointerUp). */
  finish(point) {
    if (this.ended) return;
    const smoothing = this.s.smoothing;
    this.s.smoothing = 0;
    this.extend(point);
    this.s.smoothing = smoothing;
  }

  /** Build-up: the dabs due at `now` while the pointer rests. The stub engine has no build-up. */
  tick(now) {
    void now;
  }

  effectiveSize(pressure) {
    return effectiveSize(this.s, pressure);
  }

  dab(x, y, pressure = 1) {
    const size = this.effectiveSize(pressure);
    const flow = dabFlow(this.s, pressure);
    if (!this.geometryMods.length) {
      this.paintDab({ x, y, size, flow, angle: this.s.angle, roundness: this.s.roundness, flipX: !!this.preset.tip.flipX, flipY: !!this.preset.tip.flipY, color: null });
      return;
    }
    const prev = this.lastDab;
    const dab = {
      x, y, pressure, size, angle: this.s.angle ?? 0, roundness: this.s.roundness ?? 1, flipX: this.preset.tip.flipX, flipY: this.preset.tip.flipY,
      opacity: 1, flow, color: dabColor(this.s), tip: this.preset.tip, index: this.dabs, t: (this.current?.time ?? 0) - (this.t0 ?? 0), sample: this.current,
      direction: prev ? (Math.atan2(y - prev.y, x - prev.x) * 180) / Math.PI : 0, seed: this.seed,
    };
    this.lastDab = dab;
    // a colour a modifier set goes through the mode's constraint (S2.7: Grayscale stays grey, Indexed snaps); a mask's
    // white and an eraser's black are not colours of the image
    const constrain = this.s.mode === 'paint' ? (c) => this.ctx.constrainColor(c) : (c) => c;
    for (const d of geometryDabs(dab, this.geometryMods, this.ctx)) this.paintDab({ ...d, color: d.color ? rgbaToHex(constrain(d.color)) : null });
  }

  /** The dab's shape canvas: a decoded sampled tip, else 0.4's round dab. */
  dabShape(size, color, aliased) {
    const tip = this.preset.tip;
    if (tip.kind === 'sampled' && !aliased) {
      const c = sampleDab(tip, size, color);
      if (c) return c;
      if (!this.tipWarned) {
        // not decoded yet (prepareBrush has not finished): paint as a computed tip of the same size
        this.tipWarned = true;
        this.ctx.app?.dialogs?.toast?.('The brush tip is still loading: this stroke uses a round tip', { timeout: 2000 });
      }
    }
    return dabCanvas(size, aliased ? 1 : this.s.hardness, color, { aliased });
  }

  /** Draws one dab into ctx at alpha (0.4's dab body). */
  drawDab(ctx, d, alpha) {
    const { x, y, size } = d;
    const color = d.color ?? (this.s.mode === 'mask' ? '#ffffff' : this.s.mode === 'erase' ? '#000000' : rgbaToHex(parseColor(this.s.color)));
    const half = size / 2;
    // the cached canvas may be larger than asked (S2.8): it is drawn at 0.4's side, so the dab keeps 0.4's extent
    const side = dabDrawSide(size);
    const rx = d.roundness && d.roundness < 1 ? d.roundness : 1;
    const flipped = d.flipX || d.flipY;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.globalCompositeOperation = 'source-over';
    if (this.s.sampler) {
      // clone/heal/pattern: the sampler paints the dab area, masked by a dab shape
      const dab = this.dabShape(size, '#000000', false);
      const tmp = createCanvas(side, side);
      const tctx = tmp.getContext('2d');
      this.s.sampler(tctx, x - half - 1, y - half - 1, tmp.width, tmp.height, { x, y, size });
      tctx.globalCompositeOperation = 'destination-in';
      tctx.drawImage(dab, 0, 0, side, side);
      ctx.drawImage(tmp, Math.round(x - half - 1), Math.round(y - half - 1));
    } else {
      const aliased = this.s.antialias === false;
      const dab = this.dabShape(size, color, aliased);
      ctx.imageSmoothingEnabled = !aliased;
      if (d.angle || rx !== 1 || flipped) {
        ctx.translate(x, y);
        ctx.rotate(((d.angle ?? 0) * Math.PI) / 180);
        ctx.scale(d.flipX ? -1 : 1, rx * (d.flipY ? -1 : 1));
        ctx.drawImage(dab, -side / 2, -side / 2, side, side);
      } else if (aliased) {
        ctx.drawImage(dab, Math.round(x - side / 2), Math.round(y - side / 2), side, side);
      } else ctx.drawImage(dab, x - side / 2, y - side / 2, side, side);
    }
    ctx.restore();
  }

  paintDab(d) {
    const { x, y, size } = d;
    const half = size / 2;
    const r = { x: Math.floor(x - half - 2), y: Math.floor(y - half - 2), width: Math.ceil(size) + 5, height: Math.ceil(size) + 5 };
    if (!this.coverageMods.length) this.drawDab(this.bctx, d, d.flow);
    else this.coverageDab(d, r);
    this.dirty = this.dirty ? union(this.dirty, r) : r;
    this.frameDirty = this.frameDirty ? union(this.frameDirty, r) : r;
    this.dabs++;
  }

  /** The `coverage` stage: the dab rendered alone, its alpha handed to the modifiers, then accumulated at flow. */
  coverageDab(d, r) {
    const box = clip(r, this.canvas.width, this.canvas.height);
    if (!box) return;
    const scratch = createCanvas(box.width, box.height);
    const sctx = scratch.getContext('2d', { willReadFrequently: true });
    sctx.translate(-box.x, -box.y);
    this.drawDab(sctx, d, 1);
    sctx.setTransform(1, 0, 0, 1, 0, 0);
    const img = sctx.getImageData(0, 0, box.width, box.height);
    const mask = new Float32Array(box.width * box.height);
    for (let i = 0; i < mask.length; i++) mask[i] = img.data[i * 4 + 3] / 255;
    const m = { data: mask, width: box.width, height: box.height, x: box.x, y: box.y, scale: 1 };
    for (const mod of this.coverageMods) runModifierHook(mod, 'coverage', [m, d, mod.state, this.ctx]);
    for (let i = 0; i < mask.length; i++) img.data[i * 4 + 3] = Math.round(Math.max(0, Math.min(1, mask[i])) * 255);
    sctx.putImageData(img, 0, 0);
    this.bctx.save();
    this.bctx.globalAlpha = d.flow;
    this.bctx.globalCompositeOperation = 'source-over';
    this.bctx.drawImage(scratch, box.x, box.y);
    this.bctx.restore();
  }

  schedule() {
    if (this.rafPending) return;
    this.rafPending = true;
    requestAnimationFrame(() => {
      this.rafPending = false;
      this.flush();
    });
  }

  /** Repaints the dirty part of the target: restore backup, then composite the buffer with opacity/blend. */
  flush(all = false) {
    const r = all ? this.dirty : this.frameDirty;
    this.frameDirty = null;
    if (!r) return;
    const rect = clip(r, this.canvas.width, this.canvas.height);
    if (!rect) return;
    const ctx = this.canvas.getContext('2d');
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.beginPath();
    ctx.rect(rect.x, rect.y, rect.width, rect.height);
    ctx.clip();
    ctx.globalCompositeOperation = 'copy';
    ctx.drawImage(this.backup, rect.x, rect.y, rect.width, rect.height, rect.x, rect.y, rect.width, rect.height);
    let src = this.buffer, sx = rect.x, sy = rect.y;
    if (this.bufferMods.length) {
      // the `buffer` stage: a copy of the accumulated stroke in this rect, before opacity and the selection clip
      const tmp = createCanvas(rect.width, rect.height);
      const tctx = tmp.getContext('2d', { willReadFrequently: true });
      tctx.drawImage(this.buffer, rect.x, rect.y, rect.width, rect.height, 0, 0, rect.width, rect.height);
      const img = tctx.getImageData(0, 0, rect.width, rect.height);
      runBufferModifiers(img, rect, this.bufferMods, this.ctx);
      tctx.putImageData(img, 0, 0);
      src = tmp;
      sx = sy = 0;
    }
    // the stroke so far, clipped by the selection, as a rect-sized canvas
    if (this.selection) {
      const tmp = createCanvas(rect.width, rect.height);
      const tctx = tmp.getContext('2d');
      tctx.drawImage(src, sx, sy, rect.width, rect.height, 0, 0, rect.width, rect.height);
      tctx.globalCompositeOperation = 'destination-in';
      tctx.drawImage(this.selection.toCanvas(), -(rect.x + this.target.x), -(rect.y + this.target.y));
      src = tmp;
      sx = sy = 0;
    }
    const draw = (op, alpha) => {
      ctx.globalCompositeOperation = op;
      ctx.globalAlpha = alpha;
      ctx.drawImage(src, sx, sy, rect.width, rect.height, rect.x, rect.y, rect.width, rect.height);
    };
    const { mode, blend, opacity } = this.s;
    if (mode === 'mask') {
      // mask value follows the paint's grey level: new = old * (1 - c) + value * c
      draw('destination-out', opacity);
      draw('lighter', opacity * Math.max(0, Math.min(1, this.s.maskValue ?? 1)));
    } else if (mode === 'erase') {
      draw('destination-out', opacity);
    } else if (!CANVAS_BLEND[blend] && blend !== 'normal' && blend !== 'pass-through') {
      // blend modes Canvas 2D lacks (linear burn, vivid light, hard mix, ...): per pixel
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
      const dst = ctx.getImageData(rect.x, rect.y, rect.width, rect.height);
      const srcData = src.getContext('2d', { willReadFrequently: true }).getImageData(sx, sy, rect.width, rect.height);
      blendImages(blend, { width: rect.width, height: rect.height, data: srcData.data }, { width: rect.width, height: rect.height, data: dst.data }, opacity);
      if (this.s.lockTransparency) {
        const back = this.backup.getContext('2d', { willReadFrequently: true }).getImageData(rect.x, rect.y, rect.width, rect.height).data;
        for (let i = 3; i < dst.data.length; i += 4) dst.data[i] = back[i];
      }
      ctx.putImageData(dst, rect.x, rect.y);
    } else if (this.s.lockTransparency && (blend === 'normal' || !blend)) {
      // only the colour changes: alpha stays exactly as it was
      draw('source-atop', opacity);
    } else {
      draw(CANVAS_BLEND[blend] ?? 'source-over', opacity);
      if (this.s.lockTransparency) {
        // keep the alpha exactly as it was
        const dst = ctx.getImageData(rect.x, rect.y, rect.width, rect.height);
        const back = this.backup.getContext('2d', { willReadFrequently: true }).getImageData(rect.x, rect.y, rect.width, rect.height).data;
        for (let i = 3; i < dst.data.length; i += 4) dst.data[i] = back[i];
        ctx.putImageData(dst, rect.x, rect.y);
      }
    }
    ctx.restore();
    this.layer?.touch();
    // the layer goes along so the view's compositor repaints only this rect (canvas-view.js invalidate)
    this.onDirty?.({ x: rect.x + this.target.x, y: rect.y + this.target.y, width: rect.width, height: rect.height }, this.layer);
  }

  endModifiers() {
    for (const m of this.mods) if (typeof m.mod.end === 'function') runModifierHook(m, 'end', [m.state, this.ctx]);
  }

  end() {
    if (this.ended) return null;
    this.ended = true;
    this.flush(true);
    const entry = this.history.endStroke(this.dirty);
    // endStroke touches the layer without changing a pixel: an empty dirty rect says so, or the next repaint would
    // composite the layer's whole box again
    this.onDirty?.({ x: 0, y: 0, width: 0, height: 0 }, this.layer);
    this.endModifiers();
    return entry;
  }

  cancel() {
    if (this.ended) return;
    this.ended = true;
    this.history.cancelStroke();
    this.endModifiers();
  }

  /** The layer canvas grew during the stroke: the buffers move to the new geometry (0.4's paint.js patch). */
  migrate(target, before) {
    const dx = before.x - target.x, dy = before.y - target.y; // old canvas origin inside the new canvas
    const grow = (old) => {
      const c = document.createElement('canvas');
      c.width = target.canvas.width;
      c.height = target.canvas.height;
      c.getContext('2d').drawImage(old, dx, dy);
      return c;
    };
    this.buffer = grow(this.buffer);
    this.bctx = this.buffer.getContext('2d');
    this.backup = grow(this.backup);
    if (this.history.stroke) {
      this.history.stroke.canvas = target.canvas;
      this.history.stroke.backup = this.backup;
    }
    if (this.last) {
      this.last.x += dx;
      this.last.y += dy;
    }
    if (this.smoothed) {
      this.smoothed.x += dx;
      this.smoothed.y += dy;
    }
    if (this.lastDab) this.lastDab = { ...this.lastDab, x: this.lastDab.x + dx, y: this.lastDab.y + dy };
    const shift = (r) => (r ? { x: r.x + dx, y: r.y + dy, width: r.width, height: r.height } : r);
    this.dirty = shift(this.dirty);
    this.frameDirty = shift(this.frameDirty);
    this.canvas = target.canvas;
    this.target = target;
  }
}

function union(a, b) {
  const x1 = Math.min(a.x, b.x), y1 = Math.min(a.y, b.y);
  const x2 = Math.max(a.x + a.width, b.x + b.width), y2 = Math.max(a.y + a.height, b.y + b.height);
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}
function clip(r, w, h) {
  const x1 = Math.max(0, r.x), y1 = Math.max(0, r.y), x2 = Math.min(w, r.x + r.width), y2 = Math.min(h, r.y + r.height);
  return x2 > x1 && y2 > y1 ? { x: x1, y: y1, width: x2 - x1, height: y2 - y1 } : null;
}

// ---- previews (S2.6) ------------------------------------------------------------------------------------------

/** 0.4's Brushes panel S curve across a w × h box for a tip of `size` px. */
function sCurvePath(w, h, size, dpr) {
  const pad = size / 2 + 4 * dpr;
  const amp = Math.max(0, h / 2 - pad);
  const pts = [];
  for (let i = 0; i <= 120; i++) {
    const t = i / 120;
    pts.push([pad + t * (w - pad * 2), h / 2 - Math.sin(t * Math.PI * 2) * amp * 0.8]);
  }
  return pts;
}

/**
 * A stroke preview (the Brush Settings preview, the Brushes panel's stroke view): a real BrushStroke along `path`
 * (CSS px; default 0.4's S curve) on an offscreen canvas of width × height CSS px at `scale`, with a no-op history and
 * a synchronous flush at the end, so registered modifiers show.
 */
export function renderStrokePreview(preset, paint = {}, { width = 260, height = 64, scale = (typeof devicePixelRatio === 'number' ? devicePixelRatio : 1) || 1, path = null, color = '#000000' } = {}) {
  const w = Math.max(1, Math.round(width * scale)), h = Math.max(1, Math.round(height * scale));
  const canvas = createCanvas(w, h);
  const p = normalizeBrush(preset);
  p.tip.size = Math.max(1, Math.min(5000, p.tip.size * scale));
  p.dualBrush.tip.size = Math.max(1, Math.min(5000, p.dualBrush.tip.size * scale));
  const pts = path?.length ? path.map(([x, y]) => [x * scale, y * scale]) : sCurvePath(w, h, p.tip.size, scale);
  const history = {
    stroke: null,
    beginStroke(c) {
      const backup = createCanvas(c.width, c.height);
      backup.getContext('2d').drawImage(c, 0, 0);
      return { backup };
    },
    endStroke: () => null,
    cancelStroke() {},
  };
  // the view is dropped (a preview paints no document) but its app is kept, so ctx.app and ctx.patterns resolve; a
  // preview has a fixed seed unless paint gives one, so jitter does not change between redraws
  const { sampler: _sampler, view, preset: _preset, size: _s, hardness: _h, spacing: _sp, angle: _a, roundness: _r, ...rest } = paint ?? {};
  const app = rest.app ?? view?.app ?? null;
  const settings = { opacity: 1, flow: 1, smoothing: 0, pressureSize: false, pressureOpacity: false, seed: 1, ...rest, app, preset: p, color, mode: 'paint', blend: 'normal', lockTransparency: false, label: 'Preview' };
  const stroke = new BrushStroke({ target: { canvas, x: 0, y: 0, mask: false }, layer: null, settings, history });
  stroke.begin({ x: pts[0][0], y: pts[0][1] });
  for (const [x, y] of pts.slice(1)) stroke.extend({ x, y });
  const end = pts[pts.length - 1];
  stroke.finish({ x: end[0], y: end[1] });
  stroke.end();
  return canvas;
}
