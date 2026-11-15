// LittleCMS 2 (lcms-wasm, MIT; vendored by scripts/vendor/lcms2.mjs into src/renderer/vendor/lcms2/) for icc-engine
// (ARCHITECTURE.md "0.5 features", package 4, S6.1). The wasm is instantiated once on the main thread; profile
// handles and transforms are cached, so every call after the first is synchronous and allocation-free apart from the
// heap buffer the pixels pass through.
//
// The page loads the vendored module itself (loadLcms); Node tests hand in the npm module with setLcms. Without the
// wasm (a checkout without `npm install`, a file that did not load) `lcms()` is null and transforms.js keeps its
// JavaScript fast paths, which cover every matrix/TRC RGB and Gray profile; LUT-based profiles then convert nothing.
import { builtinIcc } from './profiles.js';

let L = null;
let loading = null;

/** Installs an instantiated lcms-wasm module (Node tests: `await instantiate({ wasmBinary })`). */
export function setLcms(mod) {
  if (L && L !== mod) closeAll();
  L = mod ?? null;
}
/** The instantiated module, or null while the wasm is not there. */
export const lcms = () => L;

/**
 * Loads and instantiates the vendored LittleCMS. The wasm bytes are fetched here and handed over as `wasmBinary`, so
 * the module never needs streaming compilation (the pigment:// protocol and the test server both serve
 * application/wasm, but a plain fetch works whatever the type). Resolves to the module, or null when it cannot load.
 */
export function loadLcms({ moduleUrl = new URL('../../vendor/lcms2/lcms.js', import.meta.url).href, wasmUrl = new URL('../../vendor/lcms2/lcms.wasm', import.meta.url).href } = {}) {
  if (L) return Promise.resolve(L);
  if (!loading) {
    loading = (async () => {
      try {
        const [mod, bytes] = await Promise.all([import(moduleUrl), fetch(wasmUrl).then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`lcms.wasm: ${r.status}`))))]);
        // print/printErr: LittleCMS has nothing to say on the console in normal use; its messages are not the user's
        const m = await mod.instantiate({ wasmBinary: new Uint8Array(bytes), print: () => {}, printErr: () => {} });
        setLcms(m);
        return m;
      } catch {
        loading = null;
        return null;
      }
    })();
  }
  return loading;
}

// ---- pixel formats (lcms2.h's TYPE_* macros) ---------------------------------------------------------------------

const PT_GRAY = 3, PT_RGB = 4, PT_CMYK = 6, PT_LAB = 10;
const fmt = ({ space, channels, extra = 0, bytes, float = false }) => ((float ? 1 : 0) << 22) | (space << 16) | (extra << 7) | (channels << 3) | bytes;
export const TYPE = {
  RGBA_8: fmt({ space: PT_RGB, channels: 3, extra: 1, bytes: 1 }),
  RGBA_16: fmt({ space: PT_RGB, channels: 3, extra: 1, bytes: 2 }),
  RGBA_FLT: fmt({ space: PT_RGB, channels: 3, extra: 1, bytes: 4, float: true }),
  RGB_8: fmt({ space: PT_RGB, channels: 3, bytes: 1 }),
  RGB_DBL: fmt({ space: PT_RGB, channels: 3, bytes: 0, float: true }),
  GRAY_8: fmt({ space: PT_GRAY, channels: 1, bytes: 1 }),
  GRAY_DBL: fmt({ space: PT_GRAY, channels: 1, bytes: 0, float: true }),
  CMYK_8: fmt({ space: PT_CMYK, channels: 4, bytes: 1 }),
  LAB_DBL: fmt({ space: PT_LAB, channels: 3, bytes: 0, float: true }),
};
const INTENTS = { perceptual: 0, relative: 1, 'relative-colorimetric': 1, saturation: 2, absolute: 3, 'absolute-colorimetric': 3 };
const FLAGS_BPC = 0x2000;
const FLAGS_COPY_ALPHA = 0x04000000;
const FLAGS_NOCACHE = 0x0040;

export const intentCode = (intent) => INTENTS[intent] ?? 0;

// ---- profile handles ---------------------------------------------------------------------------------------------

const handles = new Map(); // profile id -> handle

/** The LittleCMS handle of a ColorProfile (null: the working space, sRGB), or 0 when it cannot be opened. */
export function profileHandle(profile) {
  if (!L) return 0;
  const id = profile?.id ?? 'srgb';
  if (handles.has(id)) return handles.get(id);
  let h = 0;
  try {
    if (id === 'lab-d50') h = L.cmsCreateLab4Profile(null);
    else if (id === 'srgb' && !profile?.bytes) h = L.cmsCreate_sRGBProfile();
    else {
      const bytes = profile?.bytes ?? builtinIcc(id);
      if (bytes?.length) h = L.cmsOpenProfileFromMem(bytes, bytes.length);
    }
  } catch {
    h = 0;
  }
  handles.set(id, h || 0);
  return h || 0;
}

const transforms = new Map(); // key -> handle

/**
 * A cached LittleCMS transform handle between two profiles, or 0. `inFmt` / `outFmt` are TYPE values; alpha is copied
 * for the RGBA formats.
 */
export function lcmsTransform(from, to, { intent = 'perceptual', bpc = true, inFmt = TYPE.RGBA_8, outFmt = inFmt } = {}) {
  if (!L) return 0;
  const key = `${from?.id ?? 'srgb'}>${to?.id ?? 'srgb'}|${intentCode(intent)}|${bpc ? 1 : 0}|${inFmt}|${outFmt}`;
  if (transforms.has(key)) return transforms.get(key);
  const a = profileHandle(from), b = profileHandle(to);
  let t = 0;
  if (a && b) {
    const alpha = (inFmt >> 7) & 7 && (outFmt >> 7) & 7 ? FLAGS_COPY_ALPHA : 0;
    try {
      t = L.cmsCreateTransform(a, inFmt, b, outFmt, intentCode(intent), (bpc ? FLAGS_BPC : 0) | alpha | FLAGS_NOCACHE) || 0;
    } catch {
      t = 0;
    }
  }
  transforms.set(key, t);
  return t;
}

// one heap buffer, grown as needed: the pixels pass through it in chunks
let heap = 0;
let heapSize = 0;
const CHUNK = 1 << 18; // pixels per cmsDoTransform call: the heap stays small whatever the image size

function heapFor(bytes) {
  if (bytes > heapSize) {
    if (heap) L._free(heap);
    heapSize = Math.max(bytes, 1 << 16);
    heap = L._malloc(heapSize);
  }
  return heap;
}

/**
 * Runs transform `t` over `n` pixels of `src` into `dst` (typed arrays of the transform's formats; they may be the
 * same array). `inBytes` / `outBytes` are bytes per pixel.
 */
export function runTransform(t, src, dst, n, inBytes, outBytes) {
  const inView = new Uint8Array(src.buffer, src.byteOffset, n * inBytes);
  const outView = new Uint8Array(dst.buffer, dst.byteOffset, n * outBytes);
  for (let at = 0; at < n; at += CHUNK) {
    const count = Math.min(CHUNK, n - at);
    // input and output side by side (different sizes: RGB bytes in, Lab doubles out), the output 8-byte aligned
    const outAt = (count * inBytes + 7) & ~7;
    const p = heapFor(outAt + count * outBytes);
    L.HEAPU8.set(inView.subarray(at * inBytes, (at + count) * inBytes), p); // HEAPU8 is read after any heap growth
    L._cmsDoTransform(t, p, p + outAt, count);
    outView.set(L.HEAPU8.subarray(p + outAt, p + outAt + count * outBytes), at * outBytes);
  }
}

/** Frees every cached handle (a new module, the tests). */
export function closeAll() {
  if (!L) return;
  try {
    for (const t of transforms.values()) if (t) L.cmsDeleteTransform(t);
    for (const h of handles.values()) if (h) L.cmsCloseProfile(h);
  } catch {}
  transforms.clear();
  handles.clear();
  heap = 0;
  heapSize = 0;
}

/** A transform's handle can be dropped when a profile goes away (a removed user profile). */
export function forgetProfile(id) {
  for (const [key, t] of [...transforms]) {
    if (key.startsWith(`${id}>`) || key.includes(`>${id}|`)) {
      if (t && L) L.cmsDeleteTransform(t);
      transforms.delete(key);
    }
  }
  const h = handles.get(id);
  if (h && L) L.cmsCloseProfile(h);
  handles.delete(id);
}
