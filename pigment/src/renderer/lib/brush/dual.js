// Dual Brush (ARCHITECTURE.md "0.5 features", S1.1, S2.4; brush-settings-panel): a second tip is stroked along the
// same path, and the brush paints only where the two meet, through the Dual Brush mode. One dab modifier of the
// engine's chain (order 600, `coverage`), registered when this file loads.
//
// The dual tip has its own size, spacing (a fraction of its size; Spacing off: one dual dab per brush dab), scatter
// (x its size, across the path, and along it with Both Axes), count and count jitter, and Flip (each dual dab flipped
// at random). Its dabs are placed in document px along the brush's dab centres as the stroke goes, kept in a grid,
// and each brush dab's coverage c meets d, the most any dual dab covers at that pixel, through the mode: multiply c d;
// darken min(c, d); overlay; color dodge c / (1 - d); color burn 1 - (1 - c) / d (Photoshop's default); linear burn
// c + d - 1; hard mix c where c + d >= 1, else 0; linear height a soft threshold of d against 1 - c.
//
// The dual brush only takes paint away from the brush's own dabs, so it reaches nothing beyond them (reach 0). A
// sampled dual tip not decoded yet paints as a computed one of the same size (S2.6). The rasters are plain typed
// arrays: a computed dual tip is drawn analytically (0.4's falloff: full to the hardness radius, then smoothstep), a
// sampled one is read once per stroke and size from tips.js.
import { registerDabModifier } from '../brush.js';
import { tipImage } from './tips.js';

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const RAD = Math.PI / 180;

// ---- the dual tip's raster ------------------------------------------------------------------------------------

/**
 * A computed tip's coverage, side = ceil(size) + 2 px (dabDrawSide), centred: { side, width, height, data: Float32Array }.
 * Hardness 1 gives an antialiased edge one pixel wide.
 */
export function computedTipRaster(size, hardness = 0.8) {
  const d = Math.max(1, Math.ceil(size));
  const side = d + 2;
  const data = new Float32Array(side * side);
  const r = Math.max(0.5, size / 2);
  const c = side / 2;
  const h = Math.min(0.999, Math.max(0, hardness));
  for (let y = 0, k = 0; y < side; y++) {
    for (let x = 0; x < side; x++, k++) {
      const dist = Math.hypot(x + 0.5 - c, y + 0.5 - c);
      let a;
      if (hardness >= 1) a = clamp01(r - dist + 0.5);
      else {
        const t = dist / r;
        if (t <= h) a = 1;
        else if (t >= 1) a = 0;
        else {
          const u = (t - h) / (1 - h);
          a = 1 - u * u * (3 - 2 * u);
        }
      }
      data[k] = a;
    }
  }
  return { side, width: side, height: side, data };
}

/** A sampled tip's coverage at `size` (tips.js tipImage), or null until the sample is decoded. Browser only. */
function sampledTipRaster(tip, size) {
  const img = tipImage(tip, size, '#000000');
  if (!img || tip?.kind !== 'sampled') return null;
  const px = img.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, img.width, img.height).data;
  const data = new Float32Array(img.width * img.height);
  for (let i = 0; i < data.length; i++) data[i] = px[i * 4 + 3] / 255;
  return { side: Math.max(1, Math.ceil(size)) + 2, width: img.width, height: img.height, data };
}

// ---- modes ------------------------------------------------------------------------------------------------------

/** The brush's coverage c and the dual coverage d through a Dual Brush mode. */
export function dualCombine(mode, c, d) {
  switch (mode) {
    case 'multiply':
      return c * d;
    case 'darken':
      return Math.min(c, d);
    case 'overlay':
      return clamp01(c < 0.5 ? 2 * c * d : 1 - 2 * (1 - c) * (1 - d));
    case 'color-dodge':
      return clamp01(c / Math.max(0.01, 1 - d));
    case 'linear-burn':
      return clamp01(c + d - 1);
    case 'hard-mix':
      return c + d >= 1 ? c : 0;
    case 'linear-height':
      return c * clamp01((d - (1 - c)) * 5 + 1);
    case 'color-burn':
    default:
      return d <= 0 ? 0 : clamp01(1 - (1 - c) / d);
  }
}

// ---- the dual stroke ----------------------------------------------------------------------------------------------

/**
 * The dual tip's dabs along a path (document px). extend(x, y) walks from the last point and places dabs at the dual
 * spacing (with scatter and count); near(box) lists those whose square reaches the box.
 */
export class DualTrail {
  constructor({ size = 25, spacing = 0.25, spacingOn = true, scatter = 0, bothAxes = false, count = 1, countJitter = 0, flip = false, random = Math.random } = {}) {
    this.size = Math.max(1, size);
    this.step = spacingOn ? Math.max(1, spacing * this.size) : 0;
    this.scatter = Math.max(0, scatter);
    this.bothAxes = !!bothAxes;
    this.count = Math.max(1, Math.min(16, Math.round(count)));
    this.countJitter = clamp01(countJitter);
    this.flip = !!flip;
    this.random = random;
    this.last = null;
    this.residual = 0;
    this.cell = Math.max(32, Math.ceil(this.size * 2));
    this.grid = new Map();
    this.length = 0;
  }

  /** Places the dabs of one point: count (jittered) dabs, scattered across dir (radians), and along it with Both Axes. */
  place(x, y, dir) {
    let n = this.count;
    if (this.countJitter > 0) n = Math.max(1, Math.round(n * (1 - this.countJitter * this.random())));
    const ux = Math.cos(dir), uy = Math.sin(dir);
    for (let i = 0; i < n; i++) {
      let px = x, py = y;
      if (this.scatter > 0) {
        const reach = this.scatter * this.size;
        const across = (this.random() * 2 - 1) * reach;
        const along = this.bothAxes ? (this.random() * 2 - 1) * reach : 0;
        px = x - uy * across + ux * along;
        py = y + ux * across + uy * along;
      }
      const dab = { x: px, y: py, flipX: this.flip && this.random() < 0.5, flipY: false };
      const key = `${Math.floor(px / this.cell)},${Math.floor(py / this.cell)}`;
      let list = this.grid.get(key);
      if (!list) this.grid.set(key, (list = []));
      list.push(dab);
      this.length++;
    }
  }

  extend(x, y) {
    if (!this.last) {
      this.last = { x, y };
      this.place(x, y, 0);
      return;
    }
    const dx = x - this.last.x, dy = y - this.last.y;
    const dist = Math.hypot(dx, dy);
    const dir = Math.atan2(dy, dx);
    if (!this.step) {
      // Spacing off: one dual dab per brush dab
      this.place(x, y, dir);
      this.last = { x, y };
      return;
    }
    let t = this.step - this.residual;
    while (t <= dist) {
      this.place(this.last.x + (dx * t) / dist, this.last.y + (dy * t) / dist, dir);
      t += this.step;
    }
    this.residual = dist - (t - this.step);
    this.last = { x, y };
  }

  /** The dabs whose box reaches { x, y, width, height } (document px). */
  near(box) {
    const r = this.size / 2 + 2;
    const out = [];
    const x0 = Math.floor((box.x - r) / this.cell), x1 = Math.floor((box.x + box.width + r) / this.cell);
    const y0 = Math.floor((box.y - r) / this.cell), y1 = Math.floor((box.y + box.height + r) / this.cell);
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        const list = this.grid.get(`${cx},${cy}`);
        if (!list) continue;
        for (const d of list) if (d.x + r >= box.x && d.x - r <= box.x + box.width && d.y + r >= box.y && d.y - r <= box.y + box.height) out.push(d);
      }
    }
    return out;
  }
}

/**
 * The dual coverage over a mask (S2.4 coverage mask, x / y in stroke-canvas px, `scale` mask px per canvas px): the
 * maximum of every dual dab's raster at each mask pixel. ox, oy: the canvas's document offset; the dabs are in
 * document px; angle (degrees) and roundness are the dual tip's.
 */
export function dualCoverage(mask, dabs, raster, { ox = 0, oy = 0, size, angle = 0, roundness = 1 } = {}) {
  const out = new Float32Array(mask.width * mask.height);
  const ms = mask.scale > 0 ? mask.scale : 1;
  const side = raster.side;
  const kx = raster.width / side, ky = raster.height / side;
  const half = side / 2;
  const a = (angle || 0) * RAD, ca = Math.cos(a), sa = Math.sin(a);
  const rn = Math.max(0.01, Math.min(1, roundness || 1));
  const R = half * 1.42;
  for (const d of dabs) {
    // the dab's centre in mask pixels, and the mask pixels its square can touch
    const cx = (d.x - ox - mask.x) * ms, cy = (d.y - oy - mask.y) * ms;
    const rr = R * ms;
    const i0 = Math.max(0, Math.floor(cx - rr)), i1 = Math.min(mask.width - 1, Math.ceil(cx + rr));
    const j0 = Math.max(0, Math.floor(cy - rr)), j1 = Math.min(mask.height - 1, Math.ceil(cy + rr));
    for (let j = j0; j <= j1; j++) {
      const vy = (j + 0.5) / ms + mask.y + oy - d.y;
      for (let i = i0; i <= i1; i++) {
        const vx = (i + 0.5) / ms + mask.x + ox - d.x;
        // into the tip's frame: turn back, unsquash, unflip
        let u = vx * ca + vy * sa;
        let v = (-vx * sa + vy * ca) / rn;
        if (d.flipX) u = -u;
        if (d.flipY) v = -v;
        const px = Math.floor((u + half) * kx), py = Math.floor((v + half) * ky);
        if (px < 0 || py < 0 || px >= raster.width || py >= raster.height) continue;
        const c = raster.data[py * raster.width + px];
        const k = j * mask.width + i;
        if (c > out[k]) out[k] = c;
      }
    }
  }
  return out;
}

// ---- the modifier -------------------------------------------------------------------------------------------------

function trailOf(db, random) {
  return new DualTrail({ size: db.tip.size, spacing: db.tip.spacing, spacingOn: db.tip.spacingOn, scatter: db.scatter, bothAxes: db.bothAxes, count: db.count, countJitter: db.countJitter, flip: db.flip, random });
}

export const dualBrush = {
  id: 'dual-brush',
  order: 600,
  enabled: (preset) => !!preset?.dualBrush?.enabled,
  begin(ctx) {
    const db = ctx.preset.dualBrush;
    const tip = db.tip;
    let raster = null;
    if (tip.kind === 'sampled') raster = sampledTipRaster(tip, tip.size);
    // not decoded yet, or a kind this release does not know: a computed tip of the same size (S1.1, S2.6)
    if (!raster) raster = computedTipRaster(tip.size, tip.kind === 'sampled' ? 1 : tip.hardness);
    return { trail: trailOf(db, ctx.random('dual-brush')), raster, lastIndex: null };
  },
  coverage(mask, dab, state, ctx) {
    const db = ctx.preset.dualBrush;
    const ox = ctx.stroke?.target?.x ?? 0, oy = ctx.stroke?.target?.y ?? 0;
    // the dual stroke follows the brush's dabs (scattered copies of one placed dab share its index: once per dab; a
    // stroke without a geometry stage hands dabs without an index, each its own placed dab)
    if (!Number.isFinite(dab.index) || dab.index !== state.lastIndex) {
      state.trail.extend(dab.x + ox, dab.y + oy);
      state.lastIndex = dab.index;
    }
    const ms = mask.scale > 0 ? mask.scale : 1;
    const box = { x: mask.x + ox, y: mask.y + oy, width: mask.width / ms, height: mask.height / ms };
    const d = dualCoverage(mask, state.trail.near(box), state.raster, { ox, oy, size: db.tip.size, angle: db.tip.angle, roundness: db.tip.roundness });
    const data = mask.data;
    for (let k = 0; k < data.length; k++) if (data[k] > 0) data[k] = dualCombine(db.mode, data[k], d[k]);
  },
  // the dual tip only takes paint away from the brush's own dabs
  reach: () => 0,
};

registerDabModifier(dualBrush);
