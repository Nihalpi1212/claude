// Brush Pose, Noise and Wet Edges (ARCHITECTURE.md "0.5 features", S1.1, S2.4; brush-settings-panel): three dab
// modifiers of the engine's chain, registered when this file loads.
//
//   - Brush Pose (order 50, `sample`): the tilt, rotation and pressure a stylus would give. Without a pen (mouse or
//     touch) the pose's values stand in for the stylus data the sample lacks; with a pen they replace it only where
//     "Override" is ticked, as in Photoshop. Tilt X / Y are -1..1 of a full 90 degree lean.
//   - Noise (order 700, `coverage`): grain on the soft parts of each tip. The grain is a fixed noise per document pixel
//     (not per dab), so overlapping dabs agree and the grain does not crawl along the stroke; it is strongest where
//     the coverage is half and nothing where the tip is solid or empty, which is why hard tips show none (Photoshop
//     says the same of its Noise).
//   - Wet Edges (order 800, `buffer`): paint pools at the edges of the stroke, the inside stays lighter, as
//     watercolour does. It works on the accumulated stroke, not per dab, so a stroke with tight spacing still has
//     dark edges and a light inside: each pixel's alpha is scaled by how near it is to the outside of the stroke,
//     measured as 1 - (its neighbourhood's minimum / its own alpha) over a square of a radius set by the tip size.
//
// None of the three puts paint beyond the tip, so their reach is 0. Pure maths (Node-tested); no canvas.
import { registerDabModifier } from '../brush.js';

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// ---- Brush Pose -----------------------------------------------------------------------------------------------

/** The pointer altitude and azimuth (radians) of a tilt in degrees, by the Pointer Events spec's conversion. */
export function tiltToAngles(tiltX, tiltY) {
  const tx = Math.tan((tiltX * Math.PI) / 180), ty = Math.tan((tiltY * Math.PI) / 180);
  const r = Math.hypot(tx, ty);
  return { altitude: r === 0 ? Math.PI / 2 : Math.atan(1 / r), azimuth: r === 0 ? 0 : (Math.atan2(ty, tx) + Math.PI * 2) % (Math.PI * 2) };
}

/** A sample with the pose applied (S2.4 `sample` stage): the pose fills what a non-pen sample lacks, or overrides. */
export function posedSample(s, pose) {
  if (!s || !pose) return s;
  const pen = s.pointerType === 'pen';
  const out = { ...s };
  if (!pen || pose.overrideTilt) {
    // 89 degrees at most: a pen lying flat has no defined direction
    out.tiltX = Math.max(-89, Math.min(89, (Number(pose.tiltX) || 0) * 90));
    out.tiltY = Math.max(-89, Math.min(89, (Number(pose.tiltY) || 0) * 90));
    Object.assign(out, tiltToAngles(out.tiltX, out.tiltY));
  }
  if (!pen || pose.overrideRotation) out.twist = (((Number(pose.rotation) || 0) % 360) + 360) % 360;
  if (!pen || pose.overridePressure) out.pressure = clamp01(Number.isFinite(pose.pressure) ? pose.pressure : 1);
  return out;
}

export const brushPose = {
  id: 'brush-pose',
  order: 50,
  enabled: (preset) => !!preset?.brushPose?.enabled,
  sample: (s, state, ctx) => posedSample(s, ctx.preset.brushPose),
  // the pose only changes what the other sections read (pressure never exceeds 1, so no dab grows)
  reach: () => 0,
};

// ---- Noise ----------------------------------------------------------------------------------------------------

/** A fixed noise value 0..1 for an integer document pixel. */
export function pixelNoise(x, y) {
  let h = (Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39) >>> 0;
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

/** Noise on one coverage value: up to +-2 x min(c, 1 - c), so half coverage dithers fully and 0 and 1 stay. */
export function noisyCoverage(c, n) {
  if (!(c > 0) || c >= 1) return c;
  return clamp01(c + (2 * n - 1) * 2 * Math.min(c, 1 - c));
}

/**
 * Applies Noise to a coverage mask (S2.4: { data, width, height, x, y, scale }, one mask pixel per 1/scale stroke-canvas
 * px); ox, oy: the stroke canvas's document offset. The noise is read at each mask pixel's document pixel.
 */
export function applyNoise(mask, ox = 0, oy = 0) {
  const { data, width, height } = mask;
  const s = mask.scale > 0 ? mask.scale : 1;
  const col = new Int32Array(width);
  for (let i = 0; i < width; i++) col[i] = Math.floor(ox + mask.x + (i + 0.5) / s);
  for (let j = 0, k = 0; j < height; j++) {
    const dy = Math.floor(oy + mask.y + (j + 0.5) / s);
    for (let i = 0; i < width; i++, k++) {
      const c = data[k];
      if (c > 0 && c < 1) data[k] = noisyCoverage(c, pixelNoise(col[i], dy));
    }
  }
  return mask;
}

export const noise = {
  id: 'noise',
  order: 700,
  enabled: (preset) => !!preset?.noise,
  coverage(mask, dab, state, ctx) {
    const t = ctx.stroke?.target;
    applyNoise(mask, t?.x ?? 0, t?.y ?? 0);
  },
  reach: () => 0,
};

// ---- Wet Edges ------------------------------------------------------------------------------------------------

/** The alpha the inside of a wet stroke keeps (the edges keep all of theirs). */
export const WET_INSIDE = 0.5;
/** Above this many pixels Wet Edges measures the edge on blocks (applyWetEdges). */
export const WET_FULL_PIXELS = 1024 * 1024;

/** The neighbourhood radius (px) Wet Edges measures the edge over, from the tip size. */
export function wetRadius(size) {
  return Math.max(1, Math.min(24, Math.round((Number(size) || 0) * 0.08)));
}

/**
 * The running minimum over a window of 2r + 1 (van Herk / Gil-Werman: three passes, whatever r), edges clamped. `line`
 * holds the n values padded by r copies of the first and last on each side; g and h are scratch arrays as long.
 */
function minLine(line, n, r, g, h, out, offset, stride) {
  const w = 2 * r + 1;
  const m = n + 2 * r;
  // g: prefix minima within blocks of w; h: suffix minima within blocks (block starts counted, not divided)
  for (let k = 0, c = 0; k < m; k++, c++) {
    const v = line[k];
    if (c === w) c = 0;
    g[k] = c === 0 || g[k - 1] > v ? v : g[k - 1];
  }
  const lastStart = Math.floor((m - 1) / w) * w;
  for (let k = m - 1, end = m - 1; k >= 0; k--) {
    const v = line[k];
    if (k < lastStart && (k + 1) % w === 0) end = k;
    h[k] = k === end || h[k + 1] > v ? v : h[k + 1];
  }
  // output i's window is [i, i + 2r] of the padded line: the suffix of i's block and the prefix of the next
  for (let i = 0, o = offset; i < n; i++, o += stride) {
    const a = h[i], b = g[i + 2 * r];
    out[o] = a < b ? a : b;
  }
}

/** Square erosion (minimum over a (2r + 1)² window, edges clamped) of an 8-bit plane. */
export function erode(src, width, height, r) {
  const tmp = new Uint8Array(width * height);
  const out = new Uint8Array(width * height);
  const n = Math.max(width, height) + 2 * r;
  const line = new Uint8Array(n), g = new Uint8Array(n), h = new Uint8Array(n);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    line.set(src.subarray(row, row + width), r);
    line.fill(src[row], 0, r);
    line.fill(src[row + width - 1], r + width, 2 * r + width);
    minLine(line, width, r, g, h, tmp, row, 1);
  }
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) line[r + y] = tmp[y * width + x];
    line.fill(tmp[x], 0, r);
    line.fill(tmp[(height - 1) * width + x], r + height, 2 * r + height);
    minLine(line, height, r, g, h, out, x, width);
  }
  return out;
}

/**
 * Wet Edges on straight RGBA of the accumulated stroke (S2.4 `buffer`: only A changes): a = a x (inside + (1 - inside)
 * x edge), edge = 1 - eroded / a. Edges clamp to the rect, so a pixel inside the stroke at a rect's border reads as
 * inside; the end of the stroke runs over its whole box once more.
 */
export function applyWetEdges(img, radius, inside = WET_INSIDE) {
  const { width, height, data } = img;
  const n = width * height;
  const alpha = new Uint8Array(n);
  let any = false;
  for (let i = 0; i < n; i++) {
    alpha[i] = data[i * 4 + 3];
    if (alpha[i]) any = true;
  }
  if (!any) return img;
  const r = Math.max(1, Math.round(radius));
  // above a megapixel (a large brush's frame) the edge is measured on blocks of f x f px (their minimum, so nothing
  // inside reads as an edge it is not): f² times less work, an edge band coarser by f px on a brush far larger
  const f = n > WET_FULL_PIXELS ? Math.ceil(Math.sqrt(n / WET_FULL_PIXELS)) : 1;
  let er, ew = width;
  if (f === 1) er = erode(alpha, width, height, r);
  else {
    ew = Math.ceil(width / f);
    const eh = Math.ceil(height / f);
    const small = new Uint8Array(ew * eh).fill(255);
    for (let y = 0; y < height; y++) {
      const sy = ((y / f) | 0) * ew;
      for (let x = 0, i = y * width; x < width; x++, i++) {
        const k = sy + ((x / f) | 0);
        if (alpha[i] < small[k]) small[k] = alpha[i];
      }
    }
    er = erode(small, ew, eh, Math.max(1, Math.round(r / f)));
  }
  for (let y = 0; y < height; y++) {
    const ey = f === 1 ? y * width : ((y / f) | 0) * ew;
    for (let x = 0, i = y * width; x < width; x++, i++) {
      const a = alpha[i];
      if (!a) continue;
      const e = er[f === 1 ? i : ey + ((x / f) | 0)];
      const edge = e >= a ? 0 : 1 - e / a;
      data[i * 4 + 3] = Math.round(a * (inside + (1 - inside) * edge));
    }
  }
  return img;
}

export const wetEdges = {
  id: 'wet-edges',
  order: 800,
  enabled: (preset) => !!preset?.wetEdges,
  buffer(img, rect, state, ctx) {
    applyWetEdges(img, wetRadius(ctx.preset.tip.size));
  },
  reach: () => 0,
};

/** The modifiers of this file (registered below). */
export const EXTRA_MODIFIERS = Object.freeze([brushPose, noise, wetEdges]);

for (const mod of EXTRA_MODIFIERS) registerDabModifier(mod);
