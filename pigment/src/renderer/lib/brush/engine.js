// The brush engine (ARCHITECTURE.md "0.5 features", S2; brush-engine-core). Callers import it from lib/brush.js (the
// facade), never from this file.
//
//   - S2.2 BrushStroke: settings in the one form (0.4's flat object, optionally with `preset`, split by
//     splitStrokeSettings); partial samples filled by normalizeSample; begin() again within a stroke starts a sub-path;
//     finish(); tick() and its own requestAnimationFrame loop for build-up and Stroke Catch-up; `leash` for Pulled
//     String Mode. One stroke is one history entry (0.4's beginStroke / endStroke / cancelStroke).
//   - S2.3 the dab model and traceDabs, the pure trace of a whole stroke. Placement (lib/brush/stroke.js) and dynamics
//     (lib/brush/dynamics.js) are pure and shared, so the trace and the painted stroke cannot drift apart. For 0.4's
//     settings and presets whose sections are all off the trace is 0.4's dab for dab, and the stroke paints through
//     0.4's code path (the goldens hold exactly).
//   - S2.4 the modifier chain: `sample` on each input sample, `geometry` on every dab (the engine's own Shape Dynamics,
//     Scattering, Color Dynamics and Transfer are modifiers 100-499), `coverage` on the dab's coverage (a reduced mask
//     above 1024 px), `buffer` on a copy of the flushed rect; each stage runs only while a modifier of it is enabled.
//   - S2.3 Transfer's opacity is a per-dab ceiling: a dab below full opacity is accumulated per pixel
//     (stroke.js accumulateCeiling); a full-opacity dab goes through 0.4's canvas path.
//   - Painting modes beyond the layer blend modes: Behind (paints under the layer's pixels), Clear (paints
//     transparency), Dissolve (each pixel opaque or untouched, with the stroke's alpha as the chance).
//   - S2.6 tips (lib/brush/tips.js), strokeReach, renderStrokePreview.
// Node-safe at import time (traceDabs and the registries run in Node tests); canvases are created only when a stroke
// paints.
import { CANVAS_BLEND, blendImages } from '../../../shared/pixels/blend.js';
import { parseColor, rgbaToHex } from '../../../shared/pixels/color.js';
import { createCanvas } from '../document.js';
import { dabDrawSide } from '../brush.js';
import { splitStrokeSettings, normalizeBrush } from './preset.js';
import { Placement, effectiveSize, dabFlow, accumulateCeiling, dissolveNoise } from './stroke.js';
import { ENGINE_MODIFIERS, ENGINE_SECTIONS } from './dynamics.js';
import { tipImage } from './tips.js';

export { registerTipKind, tipOutline, renderTip } from './tips.js';
export { BUILD_UP_INTERVAL } from './stroke.js';

/** What this engine is (S15: brush-engine-core has landed when the id is not 'classic-0.4'). */
export const ENGINE = Object.freeze({
  id: 'pigment-0.5',
  version: 2,
  features: Object.freeze({ dynamics: true, sampledTips: true, buildUp: true, smoothingModes: true, smoothCurves: true, tilt: true, modifiersFor: ENGINE_SECTIONS }),
});

/** The painting modes the engine adds to the layer blend modes (Brush and Pencil's Mode menu). */
export const PAINT_ONLY_MODES = Object.freeze(['behind', 'clear']);

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

// ---- modifiers (S2.4) ---------------------------------------------------------------------------------------------

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

// the engine's own sections: Shape Dynamics 100, Scattering 200, Color Dynamics 300, Transfer 400
for (const mod of ENGINE_MODIFIERS) registerDabModifier(mod);

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

/**
 * How far from the pointer a dab can put pixels (px): what a lazily grown layer grows by. The tip size (0.4's growth
 * margin, which covers the tip at any angle and every size dynamics can give, since they only shrink it) plus the
 * reach of every enabled modifier (Scattering's scatter x diameter; brush-settings-panel's Dual Brush and Brush Pose).
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

// ---- the stroke's context (S2.4) ----------------------------------------------------------------------------------

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

/** A placed dab before the geometry stage (S2.3). */
function makeDab(s, preset, { x, y, pressure, direction, index, t, sample, seed, color }) {
  return {
    x, y, pressure, size: effectiveSize(s, pressure), angle: s.angle ?? 0, roundness: s.roundness ?? 1, flipX: !!preset.tip.flipX, flipY: !!preset.tip.flipY,
    opacity: 1, flow: dabFlow(s, pressure), color, tip: preset.tip, index, t, sample, direction, seed,
  };
}

/** Runs the `buffer` stage on straight-alpha RGBA of the accumulated stroke inside rect (exported for tests). */
export function runBufferModifiers(img, rect, mods, ctx) {
  for (const m of mods) if (typeof m.mod.buffer === 'function') runModifierHook(m, 'buffer', [img, rect, m.state, ctx]);
  return img;
}

/**
 * The dabs of a whole stroke, without pixels or timers (S2.3): sample stages, placement, smoothing, dynamics and the
 * geometry stage. `{ break: true }` starts a sub-path; `{ tick: ms }` is time passing with the pointer at rest (build-up,
 * Stroke Catch-up: BrushStroke.tick); with `finish`, the last sample is also the release point (0.4's onPointerUp
 * extend, without smoothing), as a pointer's last move and its release are. `zoom` is the view's (Pulled String Mode).
 */
export function traceDabs(samples, settings, { seed = 1, finish = true, modifiers = [], zoom = 1 } = {}) {
  const { preset, paint } = splitStrokeSettings({ ...(settings ?? {}), seed: settings?.seed ?? seed });
  const s = strokeView(settings, preset);
  const mods = strokeModifiers(modifiers, preset, paint);
  const ctx = strokeContext({ preset, paint });
  for (const m of mods) if (typeof m.mod.begin === 'function') m.state = runModifierHook(m, 'begin', [ctx]);
  const out = [];
  const color = dabColor(s);
  let t0 = null, current = null, index = 0;
  const emit = (x, y, pressure, direction, time) => {
    const dab = makeDab(s, preset, { x, y, pressure, direction, index: index++, t: (Number.isFinite(time) ? time : current.time) - t0, sample: current, seed: paint.seed ?? seed, color: color.slice() });
    out.push(...geometryDabs(dab, mods, ctx));
  };
  const place = new Placement(s, { preset, paint, emit, zoom: () => zoom });
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
    if (raw && Number.isFinite(raw.tick) && !('x' in raw)) {
      if (started) place.tick(raw.tick);
      continue;
    }
    const smp = input(raw);
    last = raw;
    const p = { x: smp.x, y: smp.y, pressure: smp.pressure, time: smp.time };
    if (!started || newPath) {
      place.begin(p);
      started = true;
      newPath = false;
    } else place.extend(p);
  }
  if (finish && last && started) {
    const smp = input(last);
    place.finish({ x: smp.x, y: smp.y, pressure: smp.pressure, time: smp.time });
  }
  for (const m of mods) if (typeof m.mod.end === 'function') runModifierHook(m, 'end', [m.state, ctx]);
  return out;
}

// ---- the stroke -----------------------------------------------------------------------------------------------

/** Above this size (px) a dab is placed at whole pixels (S2.8; every golden dab is smaller). */
const BIG_DAB = 128;
const hasRaf = () => typeof requestAnimationFrame === 'function';
const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

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
    this.dirty = null;
    this.frameDirty = null;
    this.rafPending = false;
    this.ended = false;
    this.dabs = 0; // dabs painted (a geometry stage may make several of one placed dab)
    this.placed = 0; // dabs placed
    this.t0 = null;
    this.current = null;
    this.lastDab = null;
    this.mods = strokeModifiers(modifiers, preset, paint);
    this.seed = paint.seed ?? nextStrokeSeed();
    this.ctx = strokeContext({ preset, paint, stroke: this, layer, seed: this.seed });
    for (const m of this.mods) if (typeof m.mod.begin === 'function') m.state = runModifierHook(m, 'begin', [this.ctx]);
    this.sampleMods = this.mods.filter((m) => typeof m.mod.sample === 'function');
    this.geometryMods = this.mods.filter((m) => typeof m.mod.geometry === 'function');
    this.coverageMods = this.mods.filter((m) => typeof m.mod.coverage === 'function');
    this.bufferMods = this.mods.filter((m) => typeof m.mod.buffer === 'function');
    this.place = new Placement(this.s, { preset, paint, emit: (x, y, pressure, direction, time) => this.dab(x, y, pressure, direction, time), zoom: () => paint.view?.zoom ?? 1 });
    this.tipWarned = false;
    this.tipCache = new Map();
    this.loopId = null;
    this.clock = null;
  }

  get composite() {
    const { mode, blend } = this.s;
    if (mode === 'erase' || (mode === 'paint' && blend === 'clear')) return 'destination-out';
    if (mode === 'paint' && blend === 'behind') return 'destination-over';
    return CANVAS_BLEND[blend] ?? 'source-over';
  }

  /** Pulled String Mode's leash in document px ({ from: brush, to: pointer }), or null (S2.2; the cursor draws it). */
  get leash() {
    const l = this.ended ? null : this.place.leash();
    if (!l) return null;
    const ox = this.target.x, oy = this.target.y;
    return { from: { x: l.from.x + ox, y: l.from.y + oy }, to: { x: l.to.x + ox, y: l.to.y + oy } };
  }

  /** Converts a document point to canvas-local coordinates. */
  local(p) {
    return { x: p.x - this.target.x, y: p.y - this.target.y, pressure: p.pressure ?? 1, time: p.time };
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
    if (this.ended) return;
    const smp = this.input(point);
    // the loop's clock (performance.now) in the samples' clock: equal for pointer events (e.timeStamp), but a caller's
    // partial samples count 1 ms per px from 0, and build-up must not owe them the time since the page loaded
    if (this.clock === null) this.clock = nowMs() - smp.time;
    this.place.begin(this.local(smp));
    this.schedule();
    this.startLoop();
  }

  extend(point) {
    if (this.ended) return;
    if (this.place.extend(this.local(this.input(point)))) this.schedule();
  }

  /** Extends to the release point without smoothing (0.4's onPointerUp). */
  finish(point) {
    if (this.ended) return;
    if (this.place.finish(this.local(this.input(point)))) this.schedule();
  }

  /** Build-up and Stroke Catch-up: the dabs due at `now` (ms, the samples' clock) while the pointer rests. The
   * stroke's own loop passes performance.now() in that clock; tests pass fake times. */
  tick(now) {
    if (this.ended) return 0;
    const n = this.place.tick(now);
    if (n) this.schedule();
    return n;
  }

  /** The stroke drives its own ticks while build-up or catch-up is on (S2.2): exactly one loop per stroke. */
  startLoop() {
    if (this.loopId !== null || !this.place.wantsTicks || !hasRaf()) return;
    const step = () => {
      this.loopId = null;
      if (this.ended) return;
      this.tick(nowMs() - (this.clock ?? 0));
      this.loopId = requestAnimationFrame(step);
    };
    this.loopId = requestAnimationFrame(step);
  }

  stopLoop() {
    if (this.loopId !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this.loopId);
    this.loopId = null;
  }

  effectiveSize(pressure) {
    return effectiveSize(this.s, pressure);
  }

  dab(x, y, pressure = 1, direction = 0, time = undefined) {
    const size = this.effectiveSize(pressure);
    const flow = dabFlow(this.s, pressure);
    if (!this.geometryMods.length) {
      this.placed++;
      this.paintDab({ x, y, size, flow, opacity: 1, angle: this.s.angle, roundness: this.s.roundness, flipX: !!this.preset.tip.flipX, flipY: !!this.preset.tip.flipY, color: null });
      return;
    }
    const t = (Number.isFinite(time) ? time : this.current?.time ?? 0) - (this.t0 ?? 0);
    // index: the placed dab's number (as traceDabs counts), whatever a geometry stage makes of it
    const dab = makeDab(this.s, this.preset, { x, y, pressure, direction, index: this.placed++, t, sample: this.current, seed: this.seed, color: dabColor(this.s) });
    this.lastDab = dab;
    // a colour a modifier set goes through the mode's constraint (S2.7: Grayscale stays grey, Indexed snaps); a mask's
    // white and an eraser's black are not colours of the image
    const constrain = this.s.mode === 'paint' ? (c) => this.ctx.constrainColor(c) : (c) => c;
    for (const d of geometryDabs(dab, this.geometryMods, this.ctx)) this.paintDab({ ...d, color: d.color ? rgbaToHex(constrain(d.color)) : null });
  }

  /** The dab's image: its tip (a decoded sampled tip, a registered kind) or 0.4's round dab. */
  dabShape(size, color, aliased) {
    const tip = this.preset.tip;
    const img = tipImage(tip, size, color, { hardness: aliased ? 1 : this.s.hardness, aliased, cache: this.tipCache });
    if (img) return img;
    if (!this.tipWarned) {
      // not decoded yet (prepareBrush has not finished): paint as a computed tip of the same size (S2.6)
      this.tipWarned = true;
      this.ctx.app?.dialogs?.toast?.('The brush tip is still loading: this stroke uses a round tip', { timeout: 2000 });
    }
    return tipImage({ ...tip, kind: 'computed' }, size, color, { hardness: this.s.hardness });
  }

  /**
   * A large dab's image at exactly `side` px: the caches hold 1 % size steps (S2.8), so the image is scaled once into
   * a canvas of this stroke when the same side comes twice in a row (a stroke at one size); a pressure ramp, whose
   * every dab differs, draws the cached step scaled instead of paying for a copy it would use once.
   */
  exactDab(img, side) {
    if (img.width === side && img.height === side) return img;
    const e = this.exact;
    if (e && e.src === img && e.side === side) {
      if (!e.canvas) {
        e.canvas = createCanvas(side, side);
        const g = e.canvas.getContext('2d');
        g.imageSmoothingQuality = 'high';
        g.drawImage(img, 0, 0, side, side);
      }
      return e.canvas;
    }
    this.exact = { src: img, side, canvas: null };
    return img;
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
      if (d.angle || rx !== 1 || flipped) {
        tctx.translate(side / 2, side / 2);
        tctx.rotate(((d.angle ?? 0) * Math.PI) / 180);
        tctx.scale(d.flipX ? -1 : 1, rx * (d.flipY ? -1 : 1));
        tctx.drawImage(dab, -side / 2, -side / 2, side, side);
      } else tctx.drawImage(dab, 0, 0, side, side);
      ctx.drawImage(tmp, Math.round(x - half - 1), Math.round(y - half - 1));
    } else {
      const aliased = this.s.antialias === false;
      let dab = this.dabShape(size, color, aliased);
      ctx.imageSmoothingEnabled = !aliased;
      if (d.angle || rx !== 1 || flipped) {
        ctx.translate(x, y);
        ctx.rotate(((d.angle ?? 0) * Math.PI) / 180);
        ctx.scale(d.flipX ? -1 : 1, rx * (d.flipY ? -1 : 1));
        ctx.drawImage(dab, -side / 2, -side / 2, side, side);
      } else if (aliased) {
        ctx.drawImage(dab, Math.round(x - side / 2), Math.round(y - side / 2), side, side);
      } else if (size > BIG_DAB) {
        // S2.8: a large dab is drawn unscaled at a whole pixel (a fifth of the cost of a filtered, scaled draw at
        // 2500 px); half a pixel of position does not show on a dab this size
        dab = this.exactDab(dab, side);
        if (dab.width === side && dab.height === side) ctx.drawImage(dab, Math.round(x - side / 2), Math.round(y - side / 2));
        else ctx.drawImage(dab, Math.round(x - side / 2), Math.round(y - side / 2), side, side);
      } else ctx.drawImage(dab, x - side / 2, y - side / 2, side, side);
    }
    ctx.restore();
  }

  paintDab(d) {
    const { x, y, size } = d;
    const half = size / 2;
    const r = { x: Math.floor(x - half - 2), y: Math.floor(y - half - 2), width: Math.ceil(size) + 5, height: Math.ceil(size) + 5 };
    if (!this.coverageMods.length && !((d.opacity ?? 1) < 1)) this.drawDab(this.bctx, d, d.flow);
    else this.accumulateDab(d, r);
    this.dirty = this.dirty ? union(this.dirty, r) : r;
    this.frameDirty = this.frameDirty ? union(this.frameDirty, r) : r;
    this.dabs++;
  }

  /** The dab's box in the stroke canvas, inside the selection's bounds when there is one (S2.4). */
  dabBox(r) {
    let box = clip(r, this.canvas.width, this.canvas.height);
    const sel = this.selection?.bounds;
    if (box && sel && !this.target.mask) box = intersect(box, { x: sel.x - this.target.x, y: sel.y - this.target.y, width: sel.width, height: sel.height });
    else if (box && sel && this.target.mask) box = intersect(box, sel);
    return box;
  }

  /**
   * The dab rendered alone, its coverage handed to the `coverage` modifiers (a reduced mask, scale < 1, above 1024
   * px), then accumulated: at its flow (source-over, as 0.4) or, below full opacity, toward its opacity ceiling.
   */
  accumulateDab(d, r) {
    const box = this.dabBox(r);
    if (!box) return;
    const big = Math.max(box.width, box.height);
    const scale = this.coverageMods.length && big > 1024 ? 1024 / big : 1;
    const sw = Math.max(1, Math.round(box.width * scale)), sh = Math.max(1, Math.round(box.height * scale));
    const scratch = createCanvas(sw, sh);
    const sctx = scratch.getContext('2d', { willReadFrequently: true });
    sctx.setTransform(sw / box.width, 0, 0, sh / box.height, -box.x * (sw / box.width), -box.y * (sh / box.height));
    this.drawDab(sctx, d, 1);
    sctx.setTransform(1, 0, 0, 1, 0, 0);
    if (this.coverageMods.length) {
      const img = sctx.getImageData(0, 0, sw, sh);
      const mask = new Float32Array(sw * sh);
      for (let i = 0; i < mask.length; i++) mask[i] = img.data[i * 4 + 3] / 255;
      const m = { data: mask, width: sw, height: sh, x: box.x, y: box.y, scale: sw / box.width };
      for (const mod of this.coverageMods) runModifierHook(mod, 'coverage', [m, d, mod.state, this.ctx]);
      for (let i = 0; i < mask.length; i++) img.data[i * 4 + 3] = Math.round(Math.max(0, Math.min(1, mask[i])) * 255);
      sctx.putImageData(img, 0, 0);
    }
    let src = scratch;
    if (sw !== box.width || sh !== box.height) {
      src = createCanvas(box.width, box.height);
      const fctx = src.getContext('2d');
      fctx.imageSmoothingEnabled = true;
      fctx.drawImage(scratch, 0, 0, box.width, box.height);
    }
    const o = d.opacity ?? 1;
    if (!(o < 1)) {
      this.bctx.save();
      this.bctx.globalAlpha = d.flow;
      this.bctx.globalCompositeOperation = 'source-over';
      this.bctx.drawImage(src, box.x, box.y);
      this.bctx.restore();
      return;
    }
    const dabPx = src.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, box.width, box.height).data;
    const buf = this.bctx.getImageData(box.x, box.y, box.width, box.height);
    accumulateCeiling(buf.data, dabPx, o, d.flow);
    this.bctx.putImageData(buf, box.x, box.y);
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
    } else if (blend === 'clear' || blend === 'behind') {
      // Clear paints transparency, Behind paints only where the layer is transparent; with the layer's transparency
      // locked neither can change anything (Photoshop greys them out there)
      if (!this.s.lockTransparency) draw(blend === 'clear' ? 'destination-out' : 'destination-over', opacity);
    } else if (blend === 'dissolve') {
      this.dissolve(ctx, src, sx, sy, rect, opacity);
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

  /**
   * Dissolve: each pixel of the stroke is painted fully opaque, or not at all, with its alpha (x the stroke's opacity)
   * as the chance. The noise depends on the document pixel and the stroke's seed, so every partial flush agrees.
   */
  dissolve(ctx, src, sx, sy, rect, opacity) {
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    const dst = ctx.getImageData(rect.x, rect.y, rect.width, rect.height);
    const s = src.getContext('2d', { willReadFrequently: true }).getImageData(sx, sy, rect.width, rect.height).data;
    const dd = dst.data;
    const ox = rect.x + this.target.x, oy = rect.y + this.target.y;
    const lock = !!this.s.lockTransparency;
    for (let y = 0, i = 0; y < rect.height; y++) {
      for (let x = 0; x < rect.width; x++, i += 4) {
        const a = (s[i + 3] / 255) * opacity;
        if (a <= 0 || dissolveNoise(ox + x, oy + y, this.seed) >= a) continue;
        if (lock && dd[i + 3] === 0) continue;
        dd[i] = s[i];
        dd[i + 1] = s[i + 1];
        dd[i + 2] = s[i + 2];
        if (!lock) dd[i + 3] = 255;
      }
    }
    ctx.putImageData(dst, rect.x, rect.y);
  }

  endModifiers() {
    for (const m of this.mods) if (typeof m.mod.end === 'function') runModifierHook(m, 'end', [m.state, this.ctx]);
  }

  end() {
    if (this.ended) return null;
    this.ended = true;
    this.stopLoop();
    // every flushed rect already shows the buffer composited over the backup: only what is pending is composited
    // again, so the end of a large stroke does not repaint its whole box (S2.8). A buffer modifier sees each rect on
    // its own (Wet Edges reads its neighbours), so with one the whole stroke is composited once more, as 0.4 did.
    this.flush(this.bufferMods.length > 0);
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
    this.stopLoop();
    this.history.cancelStroke();
    this.endModifiers();
  }

  /** The layer canvas grew during the stroke: the buffers move to the new geometry (0.4's paint.js patch). */
  migrate(target, before) {
    const dx = before.x - target.x, dy = before.y - target.y; // old canvas origin inside the new canvas
    const grow = (old) => {
      const c = createCanvas(target.canvas.width, target.canvas.height);
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
    this.place.migrate(dx, dy);
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
function intersect(a, b) {
  const x1 = Math.max(a.x, Math.floor(b.x)), y1 = Math.max(a.y, Math.floor(b.y));
  const x2 = Math.min(a.x + a.width, Math.ceil(b.x + b.width)), y2 = Math.min(a.y + a.height, Math.ceil(b.y + b.height));
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
 * a synchronous flush at the end, so registered modifiers show. Pen controls see a pressure that rises and falls
 * along the path, as Photoshop's preview does; build-up and catch-up do not run (no time passes).
 */
export function renderStrokePreview(preset, paint = {}, { width = 260, height = 64, scale = (typeof devicePixelRatio === 'number' ? devicePixelRatio : 1) || 1, path = null, color = '#000000' } = {}) {
  const w = Math.max(1, Math.round(width * scale)), h = Math.max(1, Math.round(height * scale));
  const canvas = createCanvas(w, h);
  const p = normalizeBrush(preset);
  p.tip.size = Math.max(1, Math.min(5000, p.tip.size * scale));
  p.dualBrush.tip.size = Math.max(1, Math.min(5000, p.dualBrush.tip.size * scale));
  p.buildUp = false;
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
  const settings = { opacity: 1, flow: 1, smoothing: 0, pressureSize: false, pressureOpacity: false, seed: 1, ...rest, smoothingOptions: { mode: 'average' }, app, preset: p, color, mode: 'paint', blend: 'normal', lockTransparency: false, label: 'Preview' };
  const stroke = new BrushStroke({ target: { canvas, x: 0, y: 0, mask: false }, layer: null, settings, history });
  const n = pts.length;
  const pressure = (i) => (n > 1 ? Math.max(0.05, Math.sin((Math.PI * i) / (n - 1))) : 1);
  stroke.begin({ x: pts[0][0], y: pts[0][1], pressure: pressure(0) });
  for (let i = 1; i < n; i++) stroke.extend({ x: pts[i][0], y: pts[i][1], pressure: pressure(i) });
  const end = pts[n - 1];
  stroke.finish({ x: end[0], y: end[1], pressure: pressure(n - 1) });
  stroke.end();
  return canvas;
}
