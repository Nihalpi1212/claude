// The colour pipeline (ARCHITECTURE.md "0.5 features", S6), skeleton file; no package edits it. It holds the colour
// engine slot (icc-engine registers LittleCMS through setColorEngine from lib/color/cmm.js), the conversions every
// module calls (S6.5), the document profile helpers (S6.2) and the display stages (S6.4).
//
// Until an engine is registered, every answer is 0.4's: sRGB numbers, no conversion, no display stage, so untagged and
// sRGB documents cost nothing and are byte- and pixel-identical to 0.4. Node-safe: nothing here touches the DOM at
// import time (lib/psd/convert.js and many Node tests import it).
import { rgbToLab, labToRgb } from '../../../shared/pixels/color.js';

/** The built-in sRGB profile; `doc.profile === null` (untagged) reads as the working RGB space, sRGB in 0.5. */
export const SRGB = Object.freeze({ id: 'srgb', name: 'sRGB IEC61966-2.1', bytes: null, colorSpace: 'rgb', wellKnown: 'srgb', source: 'builtin' });

const IDENTITY_TRANSFORM = Object.freeze({
  identity: true,
  apply(src, dst, n) {
    if (src !== dst) dst.set(src.subarray(0, n * 4));
  },
});

/** The engine until icc-engine lands (S6.1): sRGB answers, no conversion. */
const STUB_ENGINE = Object.freeze({
  id: 'none',
  available: false,
  ready: () => Promise.resolve(),
  parse: () => null,
  builtins: () => [SRGB],
  profiles: () => Promise.resolve([SRGB]),
  transform: () => IDENTITY_TRANSFORM,
  decodeConversion: () => 'default',
  adoptOnOpen() {},
  displaySpace: () => 'srgb',
});

let engine = STUB_ENGINE;
let engineReady = true; // the stub is ready at once; a registered engine until its ready() resolves
let working = { rgb: null }; // 0.6 (color-settings) sets the working spaces; null: SRGB
const hooks = { app: null }; // attachColorPipeline's app: 'color:display-changed' is emitted on it

/** Registers the colour engine (icc-engine, from lib/color/cmm.js install()); the later registration wins. */
export function setColorEngine(e) {
  if (!e || typeof e !== 'object') throw new Error('setColorEngine needs an engine object');
  engine = e;
  engineReady = false;
  const mine = e;
  Promise.resolve()
    .then(() => e.ready?.())
    .catch(() => {})
    .then(() => {
      if (engine !== mine) return;
      engineReady = true;
      displayChanged();
    });
}

/** The registered engine, or the sRGB stub (id 'none', available false). */
export const colorEngine = () => engine;

/** True once the engine can answer the synchronous calls with its own numbers (before: the sRGB stub answers). */
const live = () => engine !== STUB_ENGINE && engineReady && engine.available !== false;

/** The working RGB space: what an untagged document's numbers mean (sRGB in 0.5). */
export const workingRGB = () => working.rgb ?? SRGB;

/** color-settings (0.6) sets the working spaces; 0.5 never calls it. */
export function setWorkingSpaces({ rgb = null } = {}) {
  working = { rgb };
  displayChanged();
}

/** The profile a document's numbers are in: its own, else the working RGB space. */
export const profileOf = (doc) => doc?.profile ?? workingRGB();

const sameProfile = (a, b) => (a?.id ?? 'srgb') === (b?.id ?? 'srgb');

// ---- conversions (S6.5) --------------------------------------------------------------------------------------

const clamp255 = (v) => Math.max(0, Math.min(255, Math.round(v)));

/** RGB numbers (0..255) from one profile into another (null: the working space); identity without an engine. */
export function convertColor(rgb, from, to) {
  const src = [clamp255(rgb?.[0] ?? 0), clamp255(rgb?.[1] ?? 0), clamp255(rgb?.[2] ?? 0)];
  if (!live() || sameProfile(from ?? workingRGB(), to ?? workingRGB())) return src;
  try {
    const t = engine.transform(from ?? workingRGB(), to ?? workingRGB(), { intent: 'relative', bpc: true, format: 'rgba8' });
    if (t.identity) return src;
    const a = new Uint8ClampedArray([src[0], src[1], src[2], 255]);
    const out = new Uint8ClampedArray(4);
    t.apply(a, out, 1);
    return [out[0], out[1], out[2]];
  } catch {
    return src;
  }
}

/** Lab (D50 in an engine, the sRGB D65 maths of pixels/color.js without one) of RGB numbers in `profile`. */
export function toLab(rgb, profile = null) {
  if (live() && typeof engine.toLab === 'function') {
    try {
      return engine.toLab(rgb, profile ?? workingRGB());
    } catch {}
  }
  return rgbToLab(rgb?.[0] ?? 0, rgb?.[1] ?? 0, rgb?.[2] ?? 0);
}

/** RGB numbers (0..255, rounded) in `profile` for a Lab colour; 0.4's sRGB maths without an engine. */
export function fromLab(lab, profile = null) {
  if (live() && typeof engine.fromLab === 'function') {
    try {
      return engine.fromLab(lab, profile ?? workingRGB()).map(clamp255);
    } catch {}
  }
  return labToRgb(lab?.[0] ?? 0, lab?.[1] ?? 0, lab?.[2] ?? 0).map(clamp255);
}

/**
 * Pixels converted from the document's profile to sRGB ("Convert to sRGB" in Save for Web and the Image Processor).
 * `input` is a canvas or an ImageData-like; without an engine (or for an untagged / sRGB document) it is returned as
 * it is. Always awaited by its callers.
 */
export async function toSRGB(input, doc) {
  if (!live() || sameProfile(profileOf(doc), SRGB) || typeof engine.convertCanvas !== 'function') return input;
  return engine.convertCanvas(input, profileOf(doc), SRGB, { intent: 'perceptual' });
}

/** A canvas (or ImageData-like) converted between profiles; identity without an engine. */
export async function convertCanvas(canvas, from, to, opts = {}) {
  if (!live() || sameProfile(from ?? workingRGB(), to ?? workingRGB()) || typeof engine.convertCanvas !== 'function') return canvas;
  return engine.convertCanvas(canvas, from ?? workingRGB(), to ?? workingRGB(), opts);
}

/** A CSS colour for RGB numbers of a document: '#rrggbb' (an engine may answer `color(display-p3 …)` where needed). */
export function cssColor(rgb, doc = null) {
  if (live() && typeof engine.cssColor === 'function') {
    try {
      return engine.cssColor(rgb, profileOf(doc));
    } catch {}
  }
  return `#${[0, 1, 2].map((i) => clamp255(rgb?.[i] ?? 0).toString(16).padStart(2, '0')).join('')}`;
}

/**
 * The document's colour profile for the status bar and the Info panel: '' without an engine (both then hide it),
 * else "Untagged RGB" or the profile's name with the depth, e.g. "Display P3 (16bpc)".
 */
export function describe(doc) {
  if (!doc || engine === STUB_ENGINE || engine.available === false) return '';
  if (typeof engine.describe === 'function') {
    try {
      const s = engine.describe(doc);
      if (typeof s === 'string') return s;
    } catch {}
  }
  if (!doc.profile) return 'Untagged RGB';
  return `${doc.profile.name}${doc.depth && doc.depth !== 8 ? ` (${doc.depth}bpc)` : ''}`;
}

let cachedProfiles = null; // the engine's profiles() after the first call (OS and user profiles)

/** Every profile the UI can offer, synchronously: built-ins, then OS and user profiles once profiles() answered. */
export function profilesList() {
  if (engine === STUB_ENGINE) return [SRGB];
  const list = [];
  const seen = new Set();
  const push = (p) => {
    if (p?.id && !seen.has(p.id)) {
      seen.add(p.id);
      list.push(p);
    }
  };
  try {
    for (const p of engine.builtins?.() ?? [SRGB]) push(p);
  } catch {
    push(SRGB);
  }
  for (const p of cachedProfiles ?? []) push(p);
  if (!cachedProfiles) {
    cachedProfiles = [];
    Promise.resolve()
      .then(() => engine.profiles?.())
      .then((ps) => {
        cachedProfiles = Array.isArray(ps) ? ps : [];
      })
      .catch(() => {});
  }
  return list;
}

/** The profile with this id (a built-in, a user or OS profile the engine knows), or null. */
export function profileById(id) {
  if (!id) return null;
  if (id === SRGB.id) return SRGB;
  if (live() && typeof engine.profileById === 'function') {
    try {
      return engine.profileById(id) ?? null;
    } catch {}
  }
  return profilesList().find((p) => p.id === id) ?? null;
}

/** Emits 'color:display-changed' on the attached app (the views rebuild their display stages). */
function displayChanged() {
  try {
    hooks.app?.emit?.('color:display-changed');
  } catch {}
}
