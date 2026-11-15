// Brush dynamics (ARCHITECTURE.md "0.5 features", S1.1, S2.4; brush-engine-core): the per-dab evaluation of Shape
// Dynamics, Scattering, Color Dynamics and Transfer, as the four dab modifiers of orders 100-499 that the engine
// registers. Pure (Node-tested through traceDabs): randomness comes from ctx.random(salt), seeded per stroke, so a
// trace and the painted stroke with the same seed agree dab for dab.
//
// Controls (S1.1 ControlType) give a factor 0..1 for amounts (size, roundness, count, scatter, opacity, flow, the
// foreground/background mix) and an angle for the tip angle:
//   off 1 | fade 1 -> 0 over fadeSteps dabs | pen-pressure the pressure | pen-tilt 1 upright -> 0 flat |
//   stylus-wheel the wheel 0..1 | rotation the barrel twist / 360 | direction-like controls 1 (they only turn the tip).
// An amount with a minimum (Minimum Diameter, Roundness, Opacity, Flow) maps the factor to [minimum, 1].
//
// The options bar's pressure buttons (S2.3, "pressure overrides"): with Pressure for Size on, 0.4's pressure scaling of
// the dab size (placement) is the pen pressure control, so a Shape Dynamics size control of Pen Pressure is not
// applied a second time; with Pressure for Opacity on, 0.4's pressure scaling of the flow stays and Transfer's Flow
// control of Pen Pressure is not applied a second time. Transfer's Opacity control always acts on the dab's opacity
// ceiling (dab.opacity), which 0.4 did not have.

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const RAD = Math.PI / 180;

/** How far the pen leans: 0 upright, 1 flat on the tablet (from the sample's altitude, else its tilt). */
export function tiltAmount(sample) {
  if (!sample) return 0;
  if (Number.isFinite(sample.altitude)) return clamp01(1 - sample.altitude / (Math.PI / 2));
  const t = Math.max(Math.abs(Number(sample.tiltX) || 0), Math.abs(Number(sample.tiltY) || 0));
  return clamp01(t / 90);
}

/** The control's factor 0..1 at a dab (1 for off and for the controls that only turn the tip). */
export function controlFactor(control, { index = 0, sample = null } = {}) {
  const type = control?.type ?? 'off';
  switch (type) {
    case 'fade': {
      const steps = Math.max(1, Number(control.fadeSteps) || 25);
      return index >= steps ? 0 : 1 - index / steps;
    }
    case 'pen-pressure':
      return clamp01(Number(sample?.pressure ?? 1));
    case 'pen-tilt':
      return 1 - tiltAmount(sample);
    case 'stylus-wheel':
      return clamp01(((Number(sample?.tangentialPressure) || 0) + 1) / 2);
    case 'rotation':
      return clamp01((((Number(sample?.twist) || 0) % 360) + 360) % 360 / 360);
    default:
      return 1;
  }
}

/** The angle (degrees) a control adds to the tip at a dab. */
export function controlAngle(control, { index = 0, sample = null, direction = 0, initial = null } = {}) {
  const type = control?.type ?? 'off';
  switch (type) {
    case 'direction':
      return direction;
    case 'initial-direction':
      return initial?.direction ?? direction;
    case 'rotation':
      return Number(sample?.twist) || 0;
    case 'initial-rotation':
      return initial?.twist ?? (Number(sample?.twist) || 0);
    case 'pen-tilt':
      return Number.isFinite(sample?.azimuth) ? sample.azimuth / RAD : 0;
    case 'off':
      return 0;
    default:
      // fade, pen pressure, wheel: the factor turns the tip by up to a full turn
      return (1 - controlFactor(control, { index, sample })) * 360;
  }
}

/** A control's factor mapped to [minimum, 1] (off: 1, the minimum does not apply). */
function withMinimum(control, minimum, at) {
  if (!control || control.type === 'off') return 1;
  const f = controlFactor(control, at);
  return minimum + (1 - minimum) * f;
}

const wrapAngle = (a) => {
  let x = ((a + 180) % 360 + 360) % 360 - 180;
  if (x === -180 && a > 0) x = 180;
  return x;
};

/** The dab's control inputs. */
function at(dab, state) {
  return { index: dab.index, sample: dab.sample, direction: dab.direction, initial: state.initial };
}

/** Initial Direction and Initial Rotation: the first travel direction and the barrel twist at the start. */
function noteInitial(dab, state) {
  if (state.initial.twist === null) state.initial.twist = Number(dab.sample?.twist) || 0;
  if (state.initial.direction === null && dab.index > 0) state.initial.direction = dab.direction;
}

const begin = (salt) => (ctx) => ({ rnd: ctx.random(salt), initial: { direction: null, twist: null } });

const OFF = { type: 'off', fadeSteps: 25 };

export const shapeDynamics = {
  id: 'shape-dynamics',
  order: 100,
  enabled: (preset) => !!preset?.shapeDynamics?.enabled,
  begin: begin('shape-dynamics'),
  geometry(dab, state, ctx) {
    const sd = ctx.preset.shapeDynamics;
    const rnd = state.rnd;
    noteInitial(dab, state);
    const a = at(dab, state);
    // size: the control maps to [Minimum Diameter, 1], jitter shrinks it at random, never below the minimum
    const sizeControl = ctx.paint?.pressureSize && sd.sizeControl.type === 'pen-pressure' ? OFF : sd.sizeControl;
    const min = sd.minimumDiameter;
    let k = withMinimum(sizeControl, min, a);
    if (sd.sizeJitter > 0) k = Math.max(sizeControl.type !== 'off' || min > 0 ? min : 0, k * (1 - sd.sizeJitter * rnd()));
    // Tilt Scale: with the size controlled by pen tilt, the tip's height shrinks as the pen leans
    let roundness = dab.roundness ?? 1;
    if (sizeControl.type === 'pen-tilt' && sd.tiltScale > 0) roundness *= Math.max(0.01, 1 - (tiltAmount(dab.sample) * sd.tiltScale) / 2);
    dab.size = Math.max(1, dab.size * k);
    // angle: the control's angle and a jitter of up to +-180 deg x angleJitter
    let angle = (dab.angle ?? 0) + controlAngle(sd.angleControl, a);
    if (sd.angleJitter > 0) angle += (rnd() * 2 - 1) * sd.angleJitter * 180;
    // roundness: the control maps to [Minimum Roundness, 1], jitter squashes it
    const minR = sd.minimumRoundness;
    let rk = withMinimum(sd.roundnessControl, minR, a);
    if (sd.roundnessJitter > 0) rk = Math.max(minR, rk * (1 - sd.roundnessJitter * rnd()));
    roundness *= rk;
    if (sd.flipXJitter && rnd() < 0.5) dab.flipX = !dab.flipX;
    if (sd.flipYJitter && rnd() < 0.5) dab.flipY = !dab.flipY;
    // Brush Projection: a leaning pen squashes the tip along its lean and turns it with the pen
    if (sd.brushProjection && dab.sample?.pointerType === 'pen') {
      roundness *= Math.max(0.05, Math.sin(Number.isFinite(dab.sample.altitude) ? dab.sample.altitude : Math.PI / 2));
      if (Number.isFinite(dab.sample.azimuth)) angle += dab.sample.azimuth / RAD;
    }
    dab.angle = wrapAngle(angle);
    dab.roundness = Math.max(0.01, Math.min(1, roundness));
  },
};

export const scattering = {
  id: 'scattering',
  order: 200,
  enabled: (preset) => !!preset?.scattering?.enabled,
  begin: begin('scattering'),
  geometry(dab, state, ctx) {
    const sc = ctx.preset.scattering;
    const rnd = state.rnd;
    noteInitial(dab, state);
    const a = at(dab, state);
    let n = sc.count * controlFactor(sc.countControl, a);
    if (sc.countJitter > 0) n *= 1 - sc.countJitter * rnd();
    n = Math.max(1, Math.min(16, Math.round(n)));
    const amount = sc.scatter * controlFactor(sc.scatterControl, a);
    if (n === 1 && amount <= 0) return undefined;
    const dir = (dab.direction ?? 0) * RAD;
    const ux = Math.cos(dir), uy = Math.sin(dir);
    const out = [];
    for (let i = 0; i < n; i++) {
      const d = i === 0 ? dab : { ...dab, color: dab.color?.slice?.() ?? dab.color };
      if (amount > 0) {
        // across the stroke by up to scatter x diameter; along it too with Both Axes
        const reach = amount * dab.size;
        const across = (rnd() * 2 - 1) * reach;
        const along = sc.bothAxes ? (rnd() * 2 - 1) * reach : 0;
        d.x = dab.x - uy * across + ux * along;
        d.y = dab.y + ux * across + uy * along;
      }
      out.push(d);
    }
    return out;
  },
  /** The dabs land up to scatter x diameter from the path. */
  reach: (preset) => (preset?.scattering?.scatter ?? 0) * (preset?.tip?.size ?? 0),
};

// ---- colour ---------------------------------------------------------------------------------------------------

function hexRgb(hex, fallback = [0, 0, 0]) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex ?? ''));
  if (!m) return fallback;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHsb([r, g, b]) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
    if (h < 0) h += 1;
  }
  return [h, max === 0 ? 0 : d / max, max];
}

export function hsbToRgb([h, s, v]) {
  h = ((h % 1) + 1) % 1;
  const i = Math.floor(h * 6), f = h * 6 - i;
  const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
  const [r, g, b] = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i % 6];
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

export const colorDynamics = {
  id: 'color-dynamics',
  order: 300,
  enabled: (preset, paint) => !!preset?.colorDynamics?.enabled && (paint?.mode ?? 'paint') === 'paint',
  begin: (ctx) => ({ ...begin('color-dynamics')(ctx), strokeColor: null }),
  geometry(dab, state, ctx) {
    const cd = ctx.preset.colorDynamics;
    // Apply Per Tip off: one colour for the whole stroke, chosen at its first dab
    if (!cd.perTip && state.strokeColor) {
      dab.color = state.strokeColor.slice();
      return;
    }
    noteInitial(dab, state);
    const rnd = state.rnd;
    const fg = Array.isArray(dab.color) ? dab.color.slice(0, 3) : hexRgb(ctx.paint?.color);
    const bg = hexRgb(ctx.paint?.background, [255, 255, 255]);
    // foreground to background: the control moves toward the background as its factor falls; jitter adds to it
    let t = cd.fbControl.type === 'off' ? 0 : 1 - controlFactor(cd.fbControl, at(dab, state));
    if (cd.fbJitter > 0) t += (1 - t) * cd.fbJitter * rnd();
    const mixed = fg.map((c, i) => c + (bg[i] - c) * t);
    let [h, s, v] = rgbToHsb(mixed);
    if (cd.hueJitter > 0) h += (rnd() * 2 - 1) * cd.hueJitter * 0.5;
    if (cd.saturationJitter > 0) s = clamp01(s + (rnd() * 2 - 1) * cd.saturationJitter);
    if (cd.brightnessJitter > 0) v = clamp01(v + (rnd() * 2 - 1) * cd.brightnessJitter);
    if (cd.purity > 0) s = s + (1 - s) * cd.purity;
    else if (cd.purity < 0) s = s * (1 + cd.purity);
    dab.color = hsbToRgb([h, clamp01(s), clamp01(v)]);
    if (!cd.perTip) state.strokeColor = dab.color.slice();
  },
};

export const transfer = {
  id: 'transfer',
  order: 400,
  enabled: (preset) => !!preset?.transfer?.enabled,
  begin: begin('transfer'),
  geometry(dab, state, ctx) {
    const tr = ctx.preset.transfer;
    const rnd = state.rnd;
    noteInitial(dab, state);
    const a = at(dab, state);
    // Opacity: the dab's ceiling (the stroke's opacity still applies on top), mapped to [Minimum, 1], then jittered
    let o = withMinimum(tr.opacityControl, tr.minimumOpacity, a);
    if (tr.opacityJitter > 0) o *= 1 - tr.opacityJitter * rnd();
    dab.opacity = clamp01((dab.opacity ?? 1) * o);
    // Flow: the dab's accumulation rate
    const flowControl = ctx.paint?.pressureOpacity && tr.flowControl.type === 'pen-pressure' ? OFF : tr.flowControl;
    let f = withMinimum(flowControl, tr.minimumFlow, a);
    if (tr.flowJitter > 0) f *= 1 - tr.flowJitter * rnd();
    dab.flow = clamp01((dab.flow ?? 1) * f);
  },
};

/** The engine's own modifiers (S2.4 orders 100-499), registered by lib/brush/engine.js. */
export const ENGINE_MODIFIERS = Object.freeze([shapeDynamics, scattering, colorDynamics, transfer]);
/** The BrushPreset sections they paint (ENGINE.features.modifiersFor). */
export const ENGINE_SECTIONS = Object.freeze(['shapeDynamics', 'scattering', 'colorDynamics', 'transfer']);
