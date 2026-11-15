// Dab placement (ARCHITECTURE.md "0.5 features", S2.2, S2.3; brush-engine-core). Pure: no canvas, no timer, so
// BrushStroke (which paints) and traceDabs (which only lists the dabs, Node-tested) share every line of it and cannot
// drift apart.
//
// A Placement turns input samples (already in stroke-canvas px) into dab positions:
//   - smoothing: 'average' is 0.4's (the brush moves k = 1 - smoothing of the way to the pointer at each sample) and
//     the default, so every 0.4 stroke keeps its path; 'pulled-string' is Photoshop's Pulled String Mode (the brush
//     moves only when the pointer pulls a leash of smoothing x LEASH_PX screen px taut);
//   - Stroke Catch-up (the brush keeps following a resting pointer) and Catch-up on Stroke End;
//   - Brush Settings' "Smoothing" flag (preset.smoothCurves): the path between samples is a quadratic curve through
//     the midpoints instead of straight segments;
//   - spacing: dabs every max(0.5, size x spacing) px along the path, the leftover carried across segments (0.4's
//     code); with Spacing unticked (tip.spacingOn false) one dab per input sample;
//   - build-up (preset.buildUp, Photoshop's airbrush): while the pointer rests, tick(now) adds a dab at the last
//     position every BUILD_UP_INTERVAL ms.
// emit(x, y, pressure, direction, time) receives each dab; direction is the travel direction in degrees (0 for the
// first dab of a path), time the sample's (ms) or the tick's.

/** ms between two airbrush dabs while the pointer rests (30 a second, about Photoshop's rate). */
export const BUILD_UP_INTERVAL = 1000 / 30;
/** At most this many build-up dabs are caught up in one tick (a frame after a long stall does not flood the stroke). */
const BUILD_UP_BURST = 8;
/** Pulled String Mode: the leash at 100 % smoothing, in screen px (doc px with Adjust for Zoom off). */
export const LEASH_PX = 120;
/** Stroke Catch-up: the share of the remaining distance the brush makes up at each tick while the pointer rests. */
export const CATCH_UP_RATE = 0.25;

/** 0.4's size of a dab at `pressure` (pressure for size scales it, never below 5 % and 1 px). */
export function effectiveSize(s, pressure) {
  const base = s.size;
  if (s.pressureSize && pressure !== undefined && pressure !== 1) return Math.max(1, base * Math.max(0.05, pressure));
  return base;
}

/** 0.4's flow of a dab at `pressure` (0.4's pressure for opacity scales the flow; the goldens keep it). */
export function dabFlow(s, pressure) {
  let flow = s.flow;
  if (s.pressureOpacity && pressure !== undefined) flow *= Math.max(0.05, pressure);
  return flow;
}

const DEG = 180 / Math.PI;

export class Placement {
  /**
   * s: 0.4's merged settings view (size, spacing, smoothing, pressureSize, ...; s.smoothing stays writable);
   * preset: the stroke's BrushPreset; paint: its StrokePaint; zoom(): the view's zoom (Adjust for Zoom).
   */
  constructor(s, { preset, paint = {}, emit, zoom = () => 1 }) {
    this.s = s;
    this.emitDab = emit;
    this.zoom = zoom;
    this.spacingOn = preset?.tip?.spacingOn !== false;
    this.curves = !!preset?.smoothCurves;
    this.buildUp = !!preset?.buildUp;
    const o = paint.smoothingOptions && typeof paint.smoothingOptions === 'object' ? paint.smoothingOptions : {};
    this.pulled = o.mode === 'pulled-string';
    this.catchUp = !!o.catchUp;
    this.catchUpOnEnd = !!o.catchUpOnEnd;
    this.adjustForZoom = o.adjustForZoom !== false;
    this.last = null; // the last dab position { x, y, pressure }
    this.smoothed = null; // the brush position (what smoothing made of the pointer)
    this.pointer = null; // the last input sample's position
    this.distance = 0; // px travelled since the last dab
    this.curve = null; // smoothCurves: { ctrl: the previous brush point } of the curve being drawn
    this.time = 0; // the current sample's time
    this.lastDabTime = null;
    this.firstDir = true; // the next dab is the first of its path: direction 0
  }

  /** Whether the stroke needs ticks while the pointer rests (build-up, catch-up). */
  get wantsTicks() {
    return this.buildUp || this.catchUp;
  }

  emit(x, y, pressure, dir) {
    this.lastDabTime = this.time;
    this.emitDab(x, y, pressure, this.firstDir ? 0 : dir, this.time);
    this.firstDir = false;
  }

  /** The first dab of a (sub-)path at p ({ x, y, pressure, time }); position and smoothing reset, distance kept (0.4). */
  begin(p) {
    this.time = Number.isFinite(p.time) ? p.time : this.time;
    this.smoothed = { x: p.x, y: p.y };
    this.last = { x: p.x, y: p.y, pressure: p.pressure };
    this.pointer = { x: p.x, y: p.y, pressure: p.pressure };
    this.curve = this.curves ? { ctrl: { x: p.x, y: p.y, pressure: p.pressure } } : null;
    this.firstDir = true;
    this.emit(p.x, p.y, p.pressure, 0);
  }

  /** The leash radius in stroke-canvas px. */
  leashRadius() {
    const r = Math.min(0.95, Math.max(0, this.s.smoothing)) * LEASH_PX;
    const z = this.adjustForZoom ? Number(this.zoom()) || 1 : 1;
    return r / z;
  }

  /** Smoothing: where the brush goes for the pointer at raw; null when it stays where it is. */
  follow(raw) {
    if (this.pulled && this.s.smoothing > 0) {
      const R = this.leashRadius();
      const dx = raw.x - this.smoothed.x, dy = raw.y - this.smoothed.y;
      const d = Math.hypot(dx, dy);
      if (d <= R) return null;
      const k = (d - R) / d;
      this.smoothed = { x: this.smoothed.x + dx * k, y: this.smoothed.y + dy * k };
      return { x: this.smoothed.x, y: this.smoothed.y, pressure: raw.pressure };
    }
    // 0.4: the brush moves k of the way to the pointer
    const k = 1 - Math.min(0.95, Math.max(0, this.s.smoothing));
    this.smoothed = { x: this.smoothed.x + (raw.x - this.smoothed.x) * k, y: this.smoothed.y + (raw.y - this.smoothed.y) * k };
    return { x: this.smoothed.x, y: this.smoothed.y, pressure: raw.pressure };
  }

  /** A pointer sample: smoothing, then dabs along the path. False when no dab could be placed (the brush did not move). */
  extend(raw) {
    if (!this.last) return false;
    this.time = Number.isFinite(raw.time) ? raw.time : this.time;
    this.pointer = { x: raw.x, y: raw.y, pressure: raw.pressure };
    const p = this.follow(raw);
    if (!p) return false;
    return this.walkTo(p);
  }

  /** The release: the brush goes to the release point without smoothing (0.4's onPointerUp extend). In Pulled String
   * Mode it does so only with Catch-up on Stroke End; otherwise the release is one more pull of the leash. */
  finish(raw) {
    if (!this.last) return false;
    if (this.pulled && !this.catchUpOnEnd) return this.extend(raw);
    this.time = Number.isFinite(raw.time) ? raw.time : this.time;
    this.pointer = { x: raw.x, y: raw.y, pressure: raw.pressure };
    this.smoothed = { x: raw.x, y: raw.y };
    const p = { x: raw.x, y: raw.y, pressure: raw.pressure };
    if (this.curve) return this.curveTo(p, true);
    return this.segment(p);
  }

  walkTo(p) {
    return this.curve ? this.curveTo(p, false) : this.segment(p);
  }

  /** smoothCurves: a quadratic from the last dab through the previous brush point to the midpoint (the end: p). */
  curveTo(p, final) {
    const ctrl = this.curve.ctrl;
    const start = { x: this.last.x, y: this.last.y, pressure: this.last.pressure };
    const end = final ? p : { x: (ctrl.x + p.x) / 2, y: (ctrl.y + p.y) / 2, pressure: (ctrl.pressure + p.pressure) / 2 };
    this.curve.ctrl = { x: p.x, y: p.y, pressure: p.pressure };
    const len = Math.hypot(ctrl.x - start.x, ctrl.y - start.y) + Math.hypot(end.x - ctrl.x, end.y - ctrl.y);
    if (len < 1e-3) return false;
    const n = Math.max(1, Math.min(64, Math.ceil(len / 2)));
    let moved = false;
    for (let i = 1; i <= n; i++) {
      const t = i / n, u = 1 - t;
      const q = {
        x: u * u * start.x + 2 * u * t * ctrl.x + t * t * end.x,
        y: u * u * start.y + 2 * u * t * ctrl.y + t * t * end.y,
        pressure: start.pressure + (end.pressure - start.pressure) * t,
      };
      if (this.segment(q)) moved = true;
    }
    return moved;
  }

  /** Dabs every `step` along the straight segment from the last dab to p (0.4's code), or one dab with Spacing off. */
  segment(p) {
    const dx = p.x - this.last.x, dy = p.y - this.last.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 1e-3) return false;
    const dir = Math.atan2(dy, dx) * DEG;
    if (!this.spacingOn) {
      this.emit(p.x, p.y, p.pressure, dir);
      this.distance = 0;
      this.last = { x: p.x, y: p.y, pressure: p.pressure };
      return true;
    }
    const size = effectiveSize(this.s, p.pressure);
    const step = Math.max(0.5, size * this.s.spacing);
    const nx = dx / dist, ny = dy / dist;
    let travelled = 0;
    // place dabs every `step` along the segment, carrying the leftover from the previous segment
    let first = step - this.distance;
    if (first <= 0) first = step;
    for (let t = first; t <= dist; t += step) {
      const u = t / dist;
      const pr = this.last.pressure + (p.pressure - this.last.pressure) * u;
      this.emit(this.last.x + nx * t, this.last.y + ny * t, pr, dir);
      travelled = t;
    }
    // carry the distance since the last dab across segments that placed none (slow strokes)
    this.distance = travelled > 0 ? dist - travelled : this.distance + dist;
    this.last = { x: p.x, y: p.y, pressure: p.pressure };
    return true;
  }

  /**
   * Time passes with the pointer at rest: Stroke Catch-up moves the brush toward the pointer, build-up adds dabs at
   * the last position every BUILD_UP_INTERVAL ms. Returns the number of dabs placed.
   */
  tick(now) {
    if (!this.last || !Number.isFinite(now)) return 0;
    let n = 0;
    const count = (fn) => {
      const was = this.emitDab;
      this.emitDab = (...a) => {
        n++;
        was(...a);
      };
      try {
        fn();
      } finally {
        this.emitDab = was;
      }
    };
    if (this.catchUp && this.pointer && this.smoothed) {
      const dx = this.pointer.x - this.smoothed.x, dy = this.pointer.y - this.smoothed.y;
      if (Math.hypot(dx, dy) > 0.5) {
        this.time = now;
        this.smoothed = { x: this.smoothed.x + dx * CATCH_UP_RATE, y: this.smoothed.y + dy * CATCH_UP_RATE };
        count(() => this.walkTo({ x: this.smoothed.x, y: this.smoothed.y, pressure: this.pointer.pressure }));
      }
    }
    if (this.buildUp) {
      if (this.lastDabTime === null) this.lastDabTime = now;
      let k = 0;
      while (now - this.lastDabTime >= BUILD_UP_INTERVAL && k < BUILD_UP_BURST) {
        this.time = this.lastDabTime + BUILD_UP_INTERVAL;
        const at = this.last;
        count(() => this.emit(at.x, at.y, at.pressure, 0));
        k++;
      }
      // a long stall (a hidden window) does not owe its dabs
      if (now - this.lastDabTime >= BUILD_UP_INTERVAL) this.lastDabTime = now;
      this.time = now;
    }
    return n;
  }

  /** Pulled String Mode's leash (stroke-canvas px): from the brush to the pointer, while the pointer is away from it. */
  leash() {
    if (!this.pulled || !this.pointer || !this.smoothed) return null;
    if (Math.hypot(this.pointer.x - this.smoothed.x, this.pointer.y - this.smoothed.y) < 0.5) return null;
    return { from: { x: this.smoothed.x, y: this.smoothed.y }, to: { x: this.pointer.x, y: this.pointer.y } };
  }

  /** The stroke canvas grew: its old origin is now at (dx, dy). */
  migrate(dx, dy) {
    for (const k of ['last', 'smoothed', 'pointer']) if (this[k]) this[k] = { ...this[k], x: this[k].x + dx, y: this[k].y + dy };
    if (this.curve?.ctrl) this.curve.ctrl = { ...this.curve.ctrl, x: this.curve.ctrl.x + dx, y: this.curve.ctrl.y + dy };
  }
}

/**
 * Accumulates one dab into the stroke buffer with an opacity ceiling (Transfer's opacity, S2.3): each pixel moves
 * toward the ceiling `o` by coverage x flow of the remaining distance, a <- a + max(0, o - a) * c * f, and the colour
 * is composited with the alpha that adds. With o = 1 this is source-over at c x f, the classic path, so the two agree.
 * dst: the buffer's RGBA (straight alpha) inside the dab's box; src: the dab's RGBA at full alpha, same box.
 */
export function accumulateCeiling(dst, src, o, f) {
  const ceil = Math.max(0, Math.min(1, o));
  const flow = Math.max(0, Math.min(1, f));
  for (let i = 0; i < dst.length; i += 4) {
    const c = src[i + 3] / 255;
    if (c <= 0) continue;
    const a = dst[i + 3] / 255;
    const add = (ceil - a) * c * flow;
    if (add <= 0) continue;
    const out = a + add;
    // the source alpha that, composited source-over, adds exactly `add`
    const sa = add / (1 - a);
    const wd = a * (1 - sa);
    dst[i] = Math.round((src[i] * sa + dst[i] * wd) / out);
    dst[i + 1] = Math.round((src[i + 1] * sa + dst[i + 1] * wd) / out);
    dst[i + 2] = Math.round((src[i + 2] * sa + dst[i + 2] * wd) / out);
    dst[i + 3] = Math.round(out * 255);
  }
  return dst;
}

/** Dissolve's noise at document pixel (x, y): stable per position and seed, so partial repaints of a stroke agree. */
export function dissolveNoise(x, y, seed) {
  let h = (Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
