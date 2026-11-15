// Camera Raw develop stages (ARCHITECTURE.md "0.5 features", S8.1): the registry every develop control registers in,
// and develop(), the loop over the registered stages that 0.2's develop() became. Skeleton file; pure, no DOM, so the
// renderer, smart filters, actions and the Node tests run the same code.
//
// A stage works on float planes { R, G, B, A, w, h } of the region being developed (A straight 0..1; RGB linear light
// for 'resample' and 'linear' stages, sRGB-encoded perceptual values from the first 'perceptual' stage on). Stages run
// in this order: every 'resample' stage, then every 'linear' one, the conversion to perceptual values, then every
// 'perceptual' one; within a space by `order`, then by registration. A stage whose neutral(p) is true is skipped, and
// when every stage is neutral develop() leaves the image untouched (0.4's exact no-op for the defaults).
//
// Same id: the later registration wins, but a builtin never replaces an earlier registration. develop.js imports
// develop-more.js (camera-raw-panels) and develop-profile.js (camera-raw-workspace) before it registers 0.4's controls
// as builtins, so a package's stage with a builtin's id is the one that runs. Import rule: develop-more.js,
// develop-profile.js and their imports import this file and develop-util.js, never develop.js.
import { intersectRect } from './core.js';
import { TO_LINEAR, DEVELOP_DEFAULTS, toSrgb, clamp01, num } from './develop-util.js';

const SPACES = Object.freeze({ resample: 0, linear: 1, perceptual: 2 });
const STAGES = new Map(); // id -> { def, builtin, seq }
let seq = 0;
let sorted = null;

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

/**
 * Registers a develop stage (S8.1). Returns a function that removes this registration again (tests).
 * @param {{ id: string, order: number, space: 'linear' | 'perceptual' | 'resample',
 *   params?: { keys: string[], defaults(): object, normalize?(p: object): object },
 *   neutral(p): boolean, margin?(p, w, h): number,
 *   apply(planes, p, ctx): void | { R, G, B, A, w, h },
 *   mapPoint?(pt, p, ctx, dir): { x, y }, xmp?: object }} def
 *   params.normalize receives the whole params (defaults merged in) and returns the values of the stage's own keys.
 */
export function registerDevelopStage(def, { builtin = false } = {}) {
  if (!def || typeof def.id !== 'string' || !def.id) throw new Error('registerDevelopStage: a stage needs an id');
  if (!(def.space in SPACES)) throw new Error(`registerDevelopStage(${def.id}): space must be 'linear', 'perceptual' or 'resample'`);
  if (typeof def.apply !== 'function' || typeof def.neutral !== 'function') throw new Error(`registerDevelopStage(${def.id}): neutral() and apply() are required`);
  if (builtin && STAGES.has(def.id)) return () => {};
  const entry = { def, builtin, seq: ++seq };
  STAGES.set(def.id, entry);
  sorted = null;
  return () => {
    if (STAGES.get(def.id) !== entry) return;
    STAGES.delete(def.id);
    sorted = null;
  };
}

/** True while the stage registered under this id is a builtin (tests gate 0.4 comparisons on it, rule 11). */
export function isBuiltinStage(id) {
  return STAGES.get(id)?.builtin === true;
}

/** The registered stages in the order develop() runs them. */
export function developStages() {
  if (!sorted) {
    sorted = [...STAGES.values()]
      .sort((a, b) => SPACES[a.def.space] - SPACES[b.def.space] || (Number(a.def.order) || 0) - (Number(b.def.order) || 0) || a.seq - b.seq)
      .map((e) => e.def);
  }
  return sorted.slice();
}

/**
 * The registered stages' defaults merged into one params object (a fresh copy). 0.4's keys come first in 0.4's
 * order, so the defaults of the builtins read as 0.4's DEVELOP_DEFAULTS (plus `treatment`).
 */
export function developDefaults() {
  const merged = {};
  for (const s of developStages()) if (s.params?.defaults) Object.assign(merged, clone(s.params.defaults()));
  const out = {};
  for (const k of Object.keys(DEVELOP_DEFAULTS)) if (k in merged) out[k] = merged[k];
  for (const k of Object.keys(merged)) if (!(k in out)) out[k] = merged[k];
  return out;
}

/** Fills in every missing key (nested ones too) through the stages' defaults and normalize(); unknown keys stay. */
export function normalizeDevelopParams(params = {}) {
  const p = { ...developDefaults(), ...(params && typeof params === 'object' ? params : {}) };
  for (const s of developStages()) {
    if (typeof s.params?.normalize !== 'function') continue;
    const own = s.params.normalize(p);
    if (own && typeof own === 'object') Object.assign(p, own);
  }
  return p;
}

/** True when every registered stage is neutral for these params. */
export function developNeutral(params) {
  const p = normalizeDevelopParams(params);
  return developStages().every((s) => s.neutral(p));
}

const ctxFor = (p, rect, opts = {}) => ({
  processVersion: Number(p.processVersion) === 2 ? 2 : 1, // absent = 1 (every 0.2–0.4 smart filter and recorded step)
  rect,
  docWidth: opts.docWidth ?? rect.width,
  docHeight: opts.docHeight ?? rect.height,
  seed: num(p.seed) || 1,
});

/**
 * A point of the output image (what a tool clicks) mapped back onto the source: the inverse mapPoint of the active
 * resample stages, last stage first. The identity while no resample stage is active.
 */
export function mapToSource(pt, params, ctx = {}) {
  const p = normalizeDevelopParams(params);
  const rect = ctx.rect ?? { x: 0, y: 0, width: ctx.docWidth ?? 0, height: ctx.docHeight ?? 0 };
  const c = { ...ctxFor(p, rect, ctx), ...ctx };
  let out = { x: pt.x, y: pt.y };
  const active = developStages().filter((s) => s.space === 'resample' && typeof s.mapPoint === 'function' && !s.neutral(p));
  for (let i = active.length - 1; i >= 0; i--) out = active[i].mapPoint(out, p, c, 'inverse') ?? out;
  return out;
}

/** The largest margin (px read around a pixel) of the active stages: Infinity when one needs the whole layer. */
export function developMargin(params, w = 0, h = 0) {
  const p = normalizeDevelopParams(params);
  let m = 0;
  for (const s of developStages()) {
    if (typeof s.margin !== 'function' || s.neutral(p)) continue;
    const v = Number(s.margin(p, w, h));
    if (v === Infinity) return Infinity;
    if (Number.isFinite(v) && v > m) m = v;
  }
  return m;
}

function toPerceptual(planes) {
  const { R, G, B } = planes;
  for (let i = 0; i < R.length; i++) {
    R[i] = toSrgb(clamp01(R[i]));
    G[i] = toSrgb(clamp01(G[i]));
    B[i] = toSrgb(clamp01(B[i]));
  }
}

/**
 * Applies the develop settings to img in place (0.2's signature). Alpha is written back only when a resample stage
 * ran (it may move or uncover pixels).
 * @param {{ width: number, height: number, data: Uint8ClampedArray }} img
 * @param {object} params see developDefaults()
 * @param {{ x, y, width, height } | null} [rect] region to edit (default the whole image)
 * @param {{ docWidth?: number, docHeight?: number }} [opts] the document size for ctx (default the region's)
 */
export function develop(img, params = {}, rect = null, opts = {}) {
  const p = normalizeDevelopParams(params);
  const stages = developStages().filter((s) => !s.neutral(p));
  if (!stages.length) return img;
  const r = rect ? intersectRect(rect, { x: 0, y: 0, width: img.width, height: img.height }) : { x: 0, y: 0, width: img.width, height: img.height };
  if (!r || r.width <= 0 || r.height <= 0) return img;
  const w = r.width, h = r.height, n = w * h;
  const data = img.data;

  // unpack to linear float RGB and straight alpha
  const R = new Float32Array(n), G = new Float32Array(n), B = new Float32Array(n), A = new Float32Array(n);
  for (let y = 0, i = 0; y < h; y++) {
    let o = ((r.y + y) * img.width + r.x) * 4;
    for (let x = 0; x < w; x++, i++, o += 4) {
      R[i] = TO_LINEAR[data[o]];
      G[i] = TO_LINEAR[data[o + 1]];
      B[i] = TO_LINEAR[data[o + 2]];
      A[i] = data[o + 3] / 255;
    }
  }
  let planes = { R, G, B, A, w, h };
  const ctx = ctxFor(p, r, { docWidth: opts.docWidth ?? img.width, docHeight: opts.docHeight ?? img.height });
  let perceptual = false;
  let resampled = false;
  for (const s of stages) {
    if (s.space === 'perceptual' && !perceptual) {
      toPerceptual(planes);
      perceptual = true;
    }
    const out = s.apply(planes, p, ctx);
    if (out && out.R && out.G && out.B && out.A) planes = out;
    if (s.space === 'resample') resampled = true;
  }
  // back to perceptual (sRGB-encoded) values even when no perceptual stage ran (0.4 always converted)
  if (!perceptual) toPerceptual(planes);

  // pack
  const { R: R2, G: G2, B: B2, A: A2 } = planes;
  for (let y = 0, i = 0; y < h; y++) {
    let o = ((r.y + y) * img.width + r.x) * 4;
    for (let x = 0; x < w; x++, i++, o += 4) {
      // Uint8ClampedArray rounds to nearest on store (no manual +0.5, that would round twice)
      data[o] = R2[i] * 255;
      data[o + 1] = G2[i] * 255;
      data[o + 2] = B2[i] * 255;
      if (resampled) data[o + 3] = A2[i] * 255;
    }
  }
  return img;
}
