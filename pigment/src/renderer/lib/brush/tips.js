// Brush tips (ARCHITECTURE.md "0.5 features", S2.6, S2.8; brush-engine-core): the tip kinds, their outlines (the
// cursor's shape, tipOutline) and their images (the dabs, renderTip).
//
//   - 'computed': the round or elliptical tip of Photoshop's computed brushes. Its dab is 0.4's dab raster (dabCanvas:
//     a radial falloff from the hardness radius, cached in 1 % size steps above 128 px), drawn at sub-pixel positions
//     with bilinear filtering and turned and squashed by the dab's transform. The raster is kept because the 0.4
//     goldens (S2.3) allow 3 levels of difference: a different falloff would exceed them on soft brushes. Its outline
//     is the analytic ellipse.
//   - 'sampled': an image tip (Define Brush Preset, .abr). Its coverage comes from tool-brush.js sampleCanvas (decoded
//     by prepareBrush), scaled so the longer side is the size, cached like dabCanvas; its outline is the coverage's
//     contour at 50 %, traced once per sample with marching squares.
//   - other kinds (0.10's erodible, bristle and airbrush tips) register with registerTipKind; until one is registered
//     a tip of that kind paints as computed (S1.1).
//
// Node-safe at import time: canvases are created only when a tip is drawn.
import { dabCanvas, dabDiameter, dabDrawSide } from '../brush.js';
import { createCanvas } from '../document.js';
import { sampleCanvas } from './tool-brush.js';

const TIP_KINDS = new Map();

/** A tip kind: render(tip, size) -> canvas with the coverage in alpha; outline(tip, o) -> polygons around (0, 0). */
export function registerTipKind(kind, def) {
  if (typeof kind !== 'string' || !kind || !def) throw new Error('registerTipKind needs a kind and a definition');
  TIP_KINDS.set(kind, def);
  return () => {
    if (TIP_KINDS.get(kind) === def) TIP_KINDS.delete(kind);
  };
}

/** The definition that paints a tip: its kind's, else the computed kind's. */
export function tipKind(tip) {
  return TIP_KINDS.get(tip?.kind) ?? TIP_KINDS.get('computed');
}

// ---- outlines ---------------------------------------------------------------------------------------------------

/** Turns, squashes and flips unit-free points (px around the tip's centre, before roundness) into the dab's frame. */
function placePoints(pts, { angle = 0, roundness = 1, flipX = false, flipY = false }) {
  const a = (angle * Math.PI) / 180, ca = Math.cos(a), sa = Math.sin(a);
  const r = Math.max(0.01, Math.min(1, roundness));
  return pts.map(([px, py]) => {
    let x = px, y = py * r;
    if (flipX) x = -x;
    if (flipY) y = -y;
    return [x * ca - y * sa, x * sa + y * ca];
  });
}

/** The computed tip's outline: the ellipse of its size and roundness, turned by its angle. */
function ellipseOutline(tip, { size, angle, roundness, flipX, flipY }) {
  const rx = size / 2;
  const n = Math.max(16, Math.min(96, Math.round(size)));
  const pts = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    pts.push([Math.cos(t) * rx, Math.sin(t) * rx]);
  }
  return [placePoints(pts, { angle, roundness, flipX, flipY })];
}

const contours = new Map(); // sample key -> polygons in the unit frame (longer side 1, centred) or null

/**
 * Marching squares over a coverage grid (w x h values 0..1) at `level`: closed polygons in grid coordinates. The grid
 * is padded with zeros, so every contour closes.
 */
export function traceContours(values, w, h, level = 0.5) {
  const W = w + 2, H = h + 2;
  const v = (x, y) => (x <= 0 || y <= 0 || x > w || y > h ? 0 : values[(y - 1) * w + (x - 1)]);
  // edge points, keyed by edge: horizontal edges between (x, y) and (x + 1, y), vertical between (x, y) and (x, y + 1)
  const point = (key) => {
    const [kind, sx, sy] = key.split(',');
    const x = Number(sx), y = Number(sy);
    const a = v(x, y), b = kind === 'h' ? v(x + 1, y) : v(x, y + 1);
    const t = b === a ? 0.5 : Math.max(0, Math.min(1, (level - a) / (b - a)));
    // grid index i is the pixel whose centre is at i - 0.5 (the padding shifts by one)
    return kind === 'h' ? [x + t - 0.5, y - 0.5] : [x - 0.5, y + t - 0.5];
  };
  const links = new Map();
  const link = (e1, e2) => {
    if (!links.has(e1)) links.set(e1, []);
    if (!links.has(e2)) links.set(e2, []);
    links.get(e1).push(e2);
    links.get(e2).push(e1);
  };
  for (let y = 0; y < H - 1; y++) {
    for (let x = 0; x < W - 1; x++) {
      const c = (v(x, y) >= level ? 8 : 0) | (v(x + 1, y) >= level ? 4 : 0) | (v(x + 1, y + 1) >= level ? 2 : 0) | (v(x, y + 1) >= level ? 1 : 0);
      if (c === 0 || c === 15) continue;
      const top = `h,${x},${y}`, bottom = `h,${x},${y + 1}`, left = `v,${x},${y}`, right = `v,${x + 1},${y}`;
      switch (c) {
        case 1: case 14: link(left, bottom); break;
        case 2: case 13: link(bottom, right); break;
        case 3: case 12: link(left, right); break;
        case 4: case 11: link(top, right); break;
        case 6: case 9: link(top, bottom); break;
        case 7: case 8: link(left, top); break;
        case 5: link(left, top); link(bottom, right); break; // saddles: the two corners stay apart
        case 10: link(top, right); link(left, bottom); break;
        default: break;
      }
    }
  }
  const seen = new Set();
  const polys = [];
  for (const start of links.keys()) {
    if (seen.has(start)) continue;
    const loop = [];
    let prev = null, cur = start;
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      loop.push(point(cur));
      const next = (links.get(cur) ?? []).find((e) => e !== prev && !seen.has(e));
      prev = cur;
      cur = next;
    }
    if (loop.length >= 3) polys.push(loop);
  }
  return polys;
}

/** The sampled tip's contour in the unit frame (centred, longer side 1), traced once per sample; null in Node. */
function sampleContour(ref) {
  const key = ref?.hash || ref?.blob || '';
  if (contours.has(key)) return contours.get(key);
  const src = key ? sampleCanvas(key) : null;
  if (!src || typeof document === 'undefined') return null;
  const G = 64;
  const k = G / Math.max(src.width, src.height);
  const w = Math.max(1, Math.round(src.width * k)), h = Math.max(1, Math.round(src.height * k));
  const small = createCanvas(w, h);
  const ctx = small.getContext('2d');
  ctx.drawImage(src, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;
  const values = new Float32Array(w * h);
  for (let i = 0; i < values.length; i++) values[i] = d[i * 4 + 3] / 255;
  const side = Math.max(w, h);
  const polys = traceContours(values, w, h, 0.5).map((poly) => poly.map(([x, y]) => [(x - w / 2) / side, (y - h / 2) / side]));
  contours.set(key, polys);
  return polys;
}

/** The sampled tip's outline: its contour, or its box while the sample is not decoded. */
function sampledOutline(tip, o) {
  const ref = tip?.sample;
  let polys = sampleContour(ref);
  if (!polys?.length) {
    const w = Math.max(1, ref?.width ?? 1), h = Math.max(1, ref?.height ?? 1), s = Math.max(w, h);
    const hw = w / s / 2, hh = h / s / 2;
    polys = [[[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]]];
  }
  return polys.map((poly) => placePoints(poly.map(([x, y]) => [x * o.size, y * o.size]), o));
}

/** The tip's outline as polygons around (0, 0) in px (the cursor's shape). */
export function tipOutline(tip, { size = tip?.size ?? 24, angle = tip?.angle ?? 0, roundness = tip?.roundness ?? 1, flipX = false, flipY = false } = {}) {
  const def = tipKind(tip);
  const o = { size, angle, roundness, flipX, flipY };
  if (def?.outline) {
    try {
      const polys = def.outline(tip, o);
      if (Array.isArray(polys) && polys.length) return polys;
    } catch (err) {
      console.warn(`tip kind ${tip?.kind} outline failed`, err);
    }
  }
  return ellipseOutline(tip, o);
}

// ---- images -----------------------------------------------------------------------------------------------------

// bounded by the pixels it holds and keyed on dabCanvas's 1 % size steps, as dabCanvas's own cache (S2.8)
const sampleCache = new Map();
const SAMPLE_CACHE_PIXELS = 64 * 1024 * 1024;
let sampleCachePixels = 0;

/**
 * A decoded sampled tip (tool-brush.js sampleCanvas: coverage in alpha) scaled to `size`, in `color`; null until the
 * sample is decoded. Like dabCanvas it may be larger than asked above 128 px: draw it at dabDrawSide(size).
 */
export function sampleDab(tip, size, color = '#000000') {
  const id = tip?.sample?.hash || tip?.sample?.blob;
  const src = id ? sampleCanvas(id) : null;
  if (!src) return null;
  const d = dabDiameter(size);
  const key = `${id}|${d}|${color}`;
  let c = sampleCache.get(key);
  if (c) {
    // most recently used last, so the eviction below drops the oldest
    sampleCache.delete(key);
    sampleCache.set(key, c);
    return c;
  }
  // the longer side of the sample is the diameter
  const k = d / Math.max(src.width, src.height);
  const w = Math.max(1, Math.round(src.width * k)), h = Math.max(1, Math.round(src.height * k));
  const pad = 1;
  c = createCanvas(d + pad * 2, d + pad * 2);
  const ctx = c.getContext('2d');
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.globalCompositeOperation = 'destination-in';
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, pad + (d - w) / 2, pad + (d - h) / 2, w, h);
  const px = c.width * c.height;
  while (sampleCache.size && sampleCachePixels + px > SAMPLE_CACHE_PIXELS) {
    const [k2, old] = sampleCache.entries().next().value;
    sampleCache.delete(k2);
    sampleCachePixels -= old.width * old.height;
  }
  sampleCache.set(key, c);
  sampleCachePixels += px;
  return c;
}

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

/** A cached dab canvas at the side it is drawn at (S2.8: the cache may hold a larger one); a copy only when it differs. */
export function atDrawSide(c, size) {
  const side = dabDrawSide(size);
  if (c.width === side && c.height === side) return c;
  const out = createCanvas(side, side);
  out.getContext('2d').drawImage(c, 0, 0, side, side);
  return out;
}

/**
 * The dab image of a tip at `size` in `color` (draw it at dabDrawSide(size)), or null when the tip cannot paint yet (a
 * sampled tip not decoded). `cache` (a Map the stroke keeps) holds the images of kinds without a cache of their own.
 */
export function tipImage(tip, size, color, { hardness = tip?.hardness ?? 0.8, aliased = false, cache = null } = {}) {
  const kind = tip?.kind;
  if (aliased || !kind || kind === 'computed' || !TIP_KINDS.has(kind)) {
    if (kind === 'sampled' && !aliased) return sampleDab(tip, size, color);
    return dabCanvas(size, aliased ? 1 : hardness, color, { aliased });
  }
  if (kind === 'sampled') return sampleDab(tip, size, color);
  const key = `${dabDiameter(size)}|${color}`;
  const hit = cache?.get(key);
  if (hit) return hit;
  let img = null;
  try {
    img = tinted(TIP_KINDS.get(kind).render(tip, size), color);
  } catch (err) {
    console.warn(`tip kind ${kind} render failed`, err);
  }
  img = img ? atDrawSide(img, size) : dabCanvas(size, hardness, color);
  cache?.set(key, img);
  return img;
}

/** A tip's image for thumbnails: its coverage painted in `color`, at dabDrawSide(size). */
export function renderTip(tip, size, color = '#000') {
  const img = tipImage(tip, size, color);
  return atDrawSide(img ?? dabCanvas(size, tip?.hardness ?? 0.8, color), size);
}

registerTipKind('computed', {
  render: (tip, size) => dabCanvas(size, tip?.hardness ?? 0.8, '#000000'),
  outline: ellipseOutline,
});

registerTipKind('sampled', {
  render: (tip, size) => sampleDab(tip, size, '#000000') ?? dabCanvas(size, 1, '#000000'),
  outline: sampledOutline,
});
