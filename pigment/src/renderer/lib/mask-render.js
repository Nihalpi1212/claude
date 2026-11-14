// Mask render hook (ARCHITECTURE.md "0.4 features", K.1; E10), owned by masks-vector-masks. Every read that renders
// or bakes what a layer looks like through its masks goes through here: the compositor, layer-ops (apply,
// rasterize), depth.js (16/32-bit flatten), automate (Apply All Masks), ai/features (active pixels), image-ops (warps
// bake the vector part) and the PSD writer. Reads that edit, move, copy or display the raster mask's own pixels keep
// using `layer.mask.canvas`.
//
//   'raster' the layer mask with its density and feather (J.3)
//   'vector' the vector mask: its initialFill, the path's components with their operations, its density and feather
//   'all'    both intersected (the layer shows where both show)
//
// A part that hides nothing gives null (a disabled mask, density 0, a Reveal All vector mask with no subtracting
// component). A raster mask at density 100 % and feather 0 is returned as its own canvas, exactly as in 0.3, so a
// document without the new settings renders with no extra work. The pure maths is src/shared/pixels/mask-math.js.
//
// Caching: each part is cached per layer on what it depends on (the mask canvas or path object, density, feather,
// initialFill) and layer.version. layer.version also moves when the layer's own pixels are painted, so when only the
// version moved the raster part compares the mask's pixels with the ones it was built from and refines just the
// region a change can reach (featherReach around the changed box): painting next to, or on, a feathered mask does
// not re-blur the whole document. A 'composite' read whose last build was slow (a large document) is served from
// that build for up to REBUILD_MS, then rebuilt (the layer is touched and the view repainted): a reduced preview
// while painting or dragging a path. Bakes ('bake') are always exact.
import { createCanvas } from './document.js';
import { drawPathArea, subpathOp } from './path-ops.js';
import { maskDensity, maskFeather, isPlainMask, refineMask, refineRegion, diffBounds, vectorMaskHides, rasterMaskHides } from '../../shared/pixels/mask-math.js';

/** @typedef {'all' | 'raster' | 'vector'} MaskParts */

const REBUILD_MS = 150; // at most one slow rebuild of a part per this many ms while painting (composite reads only)
const SLOW_MS = 30; // a build slower than this is worth throttling

const PARTS = new Set(['all', 'raster', 'vector']);
const partsOf = (p) => (PARTS.has(p) ? p : 'all');

// object identities in cache keys (a mask canvas replaced by undo, a path replaced by an edit)
const ids = new WeakMap();
let nextId = 1;
function idOf(o) {
  if (!o || typeof o !== 'object') return 0;
  let id = ids.get(o);
  if (!id) ids.set(o, (id = nextId++));
  return id;
}

const rasterHides = (layer) => rasterMaskHides(layer?.mask);
const vectorHides = (layer) => vectorMaskHides(layer?.vectorMask, subpathOp);

/**
 * What a part's pixels depend on, apart from layer.version ('' when the part hides nothing). `family` leaves out the
 * path's identity: a vector part of the same family may stand in for a moment while its path is dragged.
 */
function partSig(layer, part, doc, { family = false } = {}) {
  const size = doc ? `${doc.width}x${doc.height}` : '';
  if (part === 'raster') {
    const m = layer.mask;
    return rasterHides(layer) ? `r${idOf(m.canvas)}:${m.canvas.width}x${m.canvas.height}:${maskDensity(m)}:${maskFeather(m)}:${size}` : '';
  }
  const vm = layer.vectorMask;
  return vectorHides(layer) ? `v${family ? '' : idOf(vm.path)}:${vm.initialFill === 'reveal' ? 'r' : 'h'}:${maskDensity(vm)}:${maskFeather(vm)}:${size}` : '';
}

const cache = new WeakMap(); // layer -> { raster?: Entry, vector?: Entry, all?: Entry }; Entry { sig, version, canvas, at, cost }

function entriesOf(layer) {
  let e = cache.get(layer);
  if (!e) cache.set(layer, (e = {}));
  return e;
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** True (and a rebuild is scheduled) when a slow entry was built less than REBUILD_MS ago: serve it as it is. */
function throttled(e, layer, doc, part, purpose) {
  if (purpose === 'bake' || !(e.cost > SLOW_MS)) return false;
  const age = now() - e.at;
  if (age >= REBUILD_MS) return false;
  if (!e.timer) {
    e.timer = setTimeout(() => {
      e.timer = 0;
      if (cache.get(layer)?.[part] !== e) return;
      e.at = -Infinity; // the next read rebuilds
      layer.touch?.();
      doc?.view?.invalidate?.();
    }, REBUILD_MS - age);
  }
  return true;
}

function store(layer, part, entry) {
  const entries = entriesOf(layer);
  if (entries[part]?.timer) clearTimeout(entries[part].timer);
  entries[part] = entry;
  return entry.canvas;
}

/** Serves a cached part, or builds it with `build()`; see "Caching" above. `family` lets a slow entry stand in. */
function cached(layer, doc, part, sig, purpose, build, family = sig) {
  const e = entriesOf(layer)[part];
  if (e && e.sig === sig && e.version === layer.version) return e.canvas;
  if (e && e.family === family && throttled(e, layer, doc, part, purpose)) return e.canvas;
  const t0 = now();
  const canvas = build();
  return store(layer, part, { sig, family, version: layer.version, canvas, at: now(), cost: now() - t0, timer: 0 });
}

/** White canvas whose alpha is the coverage plane. */
function planeToCanvas(alpha, w, h, into = null) {
  const c = into ?? createCanvas(w, h);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  const img = ctx.createImageData(w, h);
  const d = img.data;
  for (let i = 0, j = 0; i < alpha.length; i++, j += 4) {
    d[j] = d[j + 1] = d[j + 2] = 255;
    d[j + 3] = alpha[i];
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

/** The alpha plane of a canvas. */
function alphaOf(canvas) {
  const w = canvas.width, h = canvas.height;
  const d = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  const a = new Uint8ClampedArray(w * h);
  for (let i = 0, j = 3; i < a.length; i++, j += 4) a[i] = d[j];
  return a;
}

/** The raster part with density and feather: built once, then updated where the mask's pixels changed. */
function rasterPart(layer, doc, sig, purpose) {
  const m = layer.mask;
  const w = m.canvas.width, h = m.canvas.height;
  const e = entriesOf(layer).raster;
  if (e && e.sig === sig && e.version === layer.version) return e.canvas;
  if (e && e.sig === sig) {
    if (throttled(e, layer, doc, 'raster', purpose)) return e.canvas;
    const t0 = now();
    const raw = alphaOf(m.canvas);
    const box = diffBounds(e.raw, raw, w, h);
    if (box) {
      const { rect, alpha } = refineRegion(raw, w, h, m, box);
      planeToCanvasRect(alpha, rect, e.canvas);
    }
    Object.assign(e, { raw, version: layer.version, at: now(), cost: now() - t0 });
    return e.canvas;
  }
  const t0 = now();
  const raw = alphaOf(m.canvas);
  const canvas = planeToCanvas(refineMask(raw.slice(), w, h, m), w, h);
  return store(layer, 'raster', { sig, family: sig, version: layer.version, canvas, raw, at: now(), cost: now() - t0, timer: 0 });
}

/** Writes a coverage plane into rect of a white alpha canvas. */
function planeToCanvasRect(alpha, rect, canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const img = ctx.createImageData(rect.width, rect.height);
  const d = img.data;
  for (let i = 0, j = 0; i < alpha.length; i++, j += 4) {
    d[j] = d[j + 1] = d[j + 2] = 255;
    d[j + 3] = alpha[i];
  }
  ctx.putImageData(img, rect.x, rect.y);
}

/** The vector part, document sized: initialFill, then the components with their operations, density, feather. */
export function renderVectorMask(vm, width, height) {
  const c = createCanvas(width, height);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (vm.initialFill === 'reveal') {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
  }
  // on a revealed start a combined component adds nothing (source-over of white on white); subtract, intersect and
  // exclude composite against the start as Photoshop's "initial fill rule" does
  if (vm.path?.subpaths?.length) drawPathArea(ctx, vm.path);
  if (isPlainMask(vm)) return c;
  return planeToCanvas(refineMask(alphaOf(c), c.width, c.height, vm), c.width, c.height, c);
}

function docSize(layer, doc) {
  return { w: doc?.width ?? layer.mask?.canvas?.width ?? 1, h: doc?.height ?? layer.mask?.canvas?.height ?? 1 };
}

function partCanvas(layer, doc, part, purpose) {
  const sig = partSig(layer, part, doc);
  if (!sig) return null;
  if (part === 'raster') {
    // the 0.3 fast path: no copy, no cache entry
    if (isPlainMask(layer.mask)) return layer.mask.canvas;
    return rasterPart(layer, doc, sig, purpose);
  }
  const { w, h } = docSize(layer, doc);
  return cached(layer, doc, 'vector', sig, purpose, () => renderVectorMask(layer.vectorMask, w, h), partSig(layer, 'vector', doc, { family: true }));
}

/**
 * The document-sized alpha canvas `parts` of the layer's masks make, or null when that part masks nothing.
 * The canvas is shared (cached): callers read it and never draw into it.
 * @param {object} layer
 * @param {object} doc
 * @param {{ purpose?: 'composite' | 'bake', parts?: MaskParts }} [opts]
 * @returns {HTMLCanvasElement | null}
 */
export function maskCanvasFor(layer, doc, { purpose = 'composite', parts = 'all' } = {}) {
  if (!layer) return null;
  parts = partsOf(parts);
  if (parts !== 'all') return partCanvas(layer, doc, parts, purpose);
  const r = partCanvas(layer, doc, 'raster', purpose);
  const v = partCanvas(layer, doc, 'vector', purpose);
  if (!r || !v) return r ?? v;
  const sig = `${partSig(layer, 'raster', doc)}|${partSig(layer, 'vector', doc)}|${idOf(r)}|${idOf(v)}`;
  return cached(layer, doc, 'all', sig, purpose, () => {
    const c = createCanvas(v.width, v.height);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(r, 0, 0);
    ctx.globalCompositeOperation = 'destination-in';
    ctx.drawImage(v, 0, 0);
    return c;
  });
}

/**
 * Masks `work` (a canvas whose top-left is the document point x, y) by the layer's masks; returns the masked canvas
 * (a new one) or `work` itself when nothing masks it. 0.3's destination-in step.
 */
export function applyLayerMask(work, x, y, layer, doc, { parts = 'all' } = {}) {
  const mask = maskCanvasFor(layer, doc, { purpose: 'composite', parts });
  if (!mask) return work;
  const m = createCanvas(work.width, work.height);
  const mctx = m.getContext('2d');
  mctx.drawImage(work, 0, 0);
  mctx.globalCompositeOperation = 'destination-in';
  mctx.drawImage(mask, -x, -y);
  return m;
}

/** True when `parts` of the layer's masks hide anything. */
export function hasEffectiveMask(layer, parts = 'all') {
  parts = partsOf(parts);
  if (parts === 'raster') return rasterHides(layer);
  if (parts === 'vector') return vectorHides(layer);
  return rasterHides(layer) || vectorHides(layer);
}

/** Part of the compositor's style-cache key: changes whenever what `parts` produce could change (with layer.version). */
export function maskCacheKey(layer, parts = 'all') {
  parts = partsOf(parts);
  const r = parts === 'vector' ? '' : layer ? partSig(layer, 'raster', null) : '';
  const v = parts === 'raster' ? '' : layer ? partSig(layer, 'vector', null) : '';
  return `${parts}:${r ? 1 : 0}${v ? 1 : 0}:${r}|${v}`;
}
