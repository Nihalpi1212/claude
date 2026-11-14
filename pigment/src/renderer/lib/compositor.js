// Renders a document's layer tree to a canvas (see ARCHITECTURE.md "Compositor"). Canvas 2D does
// most blending on the GPU; blend modes it lacks fall back to src/shared/pixels/blend.js on the
// affected rectangle. Everything is cached per layer version so repainting during a brush stroke
// only touches the dirty rectangle.
import { createCanvas, intersectRect, unionRect, effectiveBlending, isDefaultBlending } from './document.js';
import { CANVAS_BLEND, blendImages } from '../../shared/pixels/blend.js';
import { compositeAdvanced, maskPartsAround, restrictsChannels, isDefaultBlendIf, alphaBox, adjustmentMix, mixAdjustment } from '../../shared/pixels/blend-if.js';
import { applyAdjustment, adjustmentDef } from '../../shared/pixels/adjust.js';
import { applyStyles, stylePadding, hasEnabledStyles, exteriorBlends } from '../../shared/pixels/styles.js';
import { maskCanvasFor, applyLayerMask, hasEffectiveMask, maskCacheKey } from './mask-render.js';
import { prepareStyles } from './style-prepare.js';
import { ALL, diffPlans, samePrefix, outerRect, unionRect as unionBox, intersectRect as intersectBox } from './repaint-plan.js';
import { maskFeather } from '../../shared/pixels/mask-math.js';

/**
 * The repaint caches (ARCHITECTURE.md "Repaint caches"), each one a switch so tests can compare a cached result with
 * a fresh composite and measurements can take one step at a time. None of them changes a pixel:
 *   reuse   the last full composite stands when nothing that draws changed (selecting a layer, a guide, history)
 *   region  only the box an edit can reach is composited again and pasted into the last full composite
 *   prefix  a composite of the layers below the one being edited is kept, so an edit high in the stack skips them
 *   chain   consecutive adjustment layers share one read and one write of the pixels; an all-white mask is skipped
 */
export const REPAINT = { reuse: true, region: true, prefix: true, chain: true };

// A region larger than this share of the document is composited whole (from the cached prefix): the paste costs more
// than it saves there
const REGION_MAX = 0.45;
// A region up to this many pixels is composited exactly even while a gesture previews (a brush dab, a small layer)
const PREVIEW_EXACT_AREA = 600 * 600;
// How many cached prefixes are kept (a document-sized canvas each): two cover going back and forth between two layers
const PREFIX_SNAPS = 2;

// object identities in the repaint keys (a canvas, styles or params object replaced by an edit or an undo)
const OIDS = new WeakMap();
let nextOid = 1;
function oid(o) {
  if (!o || typeof o !== 'object') return 0;
  let id = OIDS.get(o);
  if (!id) OIDS.set(o, (id = nextOid++));
  return id;
}

/**
 * Adjustment kinds whose result at a pixel depends only on that pixel, its document position (Grain, Gradient Map's
 * dither) or a neighbourhood the kind declares (margin, I.4), so a composite of a rect gives the pixels of a full one.
 * Equalize, Match Color, HDR Toning and Replace Color measure the whole image they are given, and Color Lookup's
 * dither follows the position in it: a document showing one of those is never composited in part for the view.
 */
const LOCAL_KINDS = new Set([
  'brightness-contrast', 'levels', 'curves', 'exposure', 'vibrance', 'color-balance', 'invert', 'posterize', 'threshold',
  'selective-color', 'desaturate', 'hue-saturation', 'black-white', 'photo-filter', 'channel-mixer', 'gradient-map',
  'shadows-highlights', 'color-vibrance', 'clarity-dehaze', 'grain', 'color-lookup',
]);
const isLocalAdjustment = (l) => LOCAL_KINDS.has(l.kind) && !(l.kind === 'color-lookup' && l.params?.dither);

/**
 * The roundtrip of a canvas pixel through putImageData and getImageData: the canvas keeps premultiplied 8-bit colour,
 * so a translucent pixel can come back a level off. ROUNDTRIP[a * 256 + c] is what colour c at alpha a reads back as,
 * measured once on a canvas like the compositor's own (a chained adjustment pass applies it where the unchained
 * passes wrote and read the canvas between two layers, so the chain gives their pixels).
 */
let ROUNDTRIP = null;
function roundtripTable() {
  if (ROUNDTRIP) return ROUNDTRIP;
  const c = createCanvas(256, 256);
  const g = c.getContext('2d', { willReadFrequently: true });
  const img = g.createImageData(256, 256);
  for (let a = 0, p = 0; a < 256; a++) {
    for (let v = 0; v < 256; v++, p += 4) {
      img.data[p] = img.data[p + 1] = img.data[p + 2] = v;
      img.data[p + 3] = a;
    }
  }
  g.putImageData(img, 0, 0);
  const back = g.getImageData(0, 0, 256, 256).data;
  const t = new Uint8Array(65536);
  for (let i = 0, p = 0; i < 65536; i++, p += 4) t[i] = back[p];
  ROUNDTRIP = t;
  return t;
}

/** Applies the canvas roundtrip to the translucent pixels of an ImageData (opaque pixels come back unchanged). */
function roundtrip(data) {
  let t = null;
  for (let p = 3; p < data.length; p += 4) {
    const a = data[p];
    if (a === 255) continue;
    t ??= roundtripTable();
    const row = a << 8;
    data[p - 3] = t[row | data[p - 3]];
    data[p - 2] = t[row | data[p - 2]];
    data[p - 1] = t[row | data[p - 1]];
  }
}

const SIMPLE_OVER = new Set(['normal', 'pass-through']);

// Advanced blending (K.3, layer-style-blending): the full options of a layer whose blending is not the default, or
// null. isDefaultBlending compares JSON, so the answer is kept per layer until its blending object or version changes.
const BLENDING_CACHE = new WeakMap();
function blendingOf(layer) {
  const b = layer.blending;
  if (!b) return null;
  const c = BLENDING_CACHE.get(layer);
  if (c && c.ref === b && c.version === layer.version) return c.full;
  const full = isDefaultBlending(b) ? null : effectiveBlending(layer);
  BLENDING_CACHE.set(layer, { ref: b, version: layer.version, full });
  return full;
}

/** The mode a layer's content is drawn with (a styled or faded Pass Through group composites as Normal). */
const modeOf = (layer) => (layer.isGroup && layer.blend === 'pass-through' ? 'normal' : layer.blend ?? 'normal');

// The modes of a layer's exterior effects (styles.js exteriorBlends), kept per styles object and layer version: a
// repaint asks on every composite whether the layer needs its effects apart, and the merge of the styles is not free
const EXTERIOR_CACHE = new WeakMap();
function exteriorOf(layer) {
  const st = layer.styles;
  const c = EXTERIOR_CACHE.get(layer);
  if (c && c.ref === st && c.version === layer.version) return c.modes;
  const modes = exteriorBlends(st);
  EXTERIOR_CACHE.set(layer, { ref: st, version: layer.version, modes });
  return modes;
}

/**
 * Photoshop composites each exterior effect onto the layers below with its own mode and the layer's content (with
 * its interior effects) with the layer's mode. Normal over Normal is one source-over, so when every one of those
 * modes is Normal the merged render (effects and content as one image) draws the same pixels and is kept: that is
 * the fast path. Otherwise the effects come apart (styledCanvas split) and drawStack composites them one by one.
 */
function needsSplit(layer) {
  const modes = exteriorOf(layer);
  if (!modes.length) return false;
  if (modeOf(layer) !== 'normal') return true;
  for (const m of modes) if (m !== 'normal') return true;
  return false;
}

/** The document box a layer draws into, effects included (groups: their visible children); null when nothing. */
function renderBounds(layer) {
  let b = null;
  if (layer.isGroup) {
    for (const c of layer.children) {
      if (!c.visible) continue;
      const cb = renderBounds(c);
      if (cb) b = b ? unionRect(b, cb) : cb;
    }
  } else b = layer.bounds();
  if (!b) return null;
  const pad = hasEnabledStyles(layer.styles) ? stylePadding(layer.styles) : 0;
  return pad ? { x: b.x - pad, y: b.y - pad, width: b.width + pad * 2, height: b.height + pad * 2 } : { ...b };
}

/** What a styled group's children render depends on: their ids, versions, visibility and order, all levels. */
function subtreeKey(group) {
  let k = '';
  for (const c of group.children) {
    k += `${c.id}:${c.version}:${c.visible ? 1 : 0};`;
    if (c.isGroup) k += `[${subtreeKey(c)}]`;
  }
  return k;
}

/** The Background layer (the bottom raster layer of the root named "Background", L.13), or null. */
function backgroundOf(doc) {
  const first = doc.root.children[0];
  return first && first.type === 'raster' && first.name === 'Background' && first.visible ? first : null;
}

/** ImageData of `canvas` (placed at document x, y) over the document rect r; transparent outside it. */
function readRegion(canvas, x, y, r) {
  const c = createCanvas(r.width, r.height);
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(canvas, x - r.x, y - r.y);
  return g.getImageData(0, 0, r.width, r.height);
}

/** `work` (at document x, y) cut to the alpha of `clip` ({ canvas, x, y }): a clipped layer outside its group. */
function clipToAlpha(work, x, y, clip) {
  const m = createCanvas(work.width, work.height);
  const g = m.getContext('2d');
  g.drawImage(work, 0, 0);
  g.globalCompositeOperation = 'destination-in';
  g.drawImage(clip.canvas, clip.x - x, clip.y - y);
  return m;
}

/**
 * Image modes (lib/modes.js): a renderer per document mode runs on every composite's output canvas
 * (the view, exports, thumbnails, smart-object hosts) so duotone inks, indexed colour tables and
 * bitmap thresholds show as the document mode defines them while pixels stay RGBA.
 * fn(doc, canvas, rect, opts) edits the canvas in place; rect is the document region it holds.
 */
const MODE_RENDERERS = new Map();
export function registerModeRenderer(mode, fn) {
  if (fn) MODE_RENDERERS.set(mode, fn);
  else MODE_RENDERERS.delete(mode);
}
/** The renderer registered for a document mode, or null (lib/io.js bakes what a mode shows into the layers of a PSD). */
export const modeRendererFor = (mode) => MODE_RENDERERS.get(mode) ?? null;

export class Compositor {
  /** @param {{ view?: boolean }} [opts] view: a view's compositor, which keeps a spare buffer and cached prefixes */
  constructor({ view = false } = {}) {
    this.view = view;
    this.styleCache = new WeakMap(); // layer -> { version, canvas, x, y }
    this.adjustCache = new WeakMap(); // layer -> { key, canvas }
    this.full = null; // { version, canvas } for the whole document
    this.groupCache = new WeakMap(); // styled group -> { key, canvas, x, y } of its children (K.3)
    this.styleRuns = 0; // applyStyles calls (tests check that a repaint next to a styled group runs none)
    this.knockStack = new Map(); // pass-through group -> { data, rect }: the backdrop its shallow knockouts reveal
    this.unready = false; // set while a styled render waits for a pattern (not cached)
    // repaint caches (REPAINT, compositeView): the plan of the last full composite, the cached composite of the units
    // below an edit ({ at, keys, canvas }), the pixel hints of brush dabs since the last composite, the spare buffer
    this.records = null;
    this.snaps = []; // up to PREFIX_SNAPS, the most recently used first
    this.hints = new Map(); // layer -> { rect, version }
    this.spare = null;
    this.fullRuns = 0; // full composites done (tests and measurements: a region repaint or a reuse does none)
    this.regionRuns = 0;
    this.previewRuns = 0;
    this.prefixHits = 0; // full composites that started from a cached prefix
  }

  /**
   * Composites `doc` (or just `rect` of it) and returns a canvas of rect size whose (0,0) is rect.x/y.
   * @param {import('./document.js').Document} doc
   * @param {{ rect?: object, skip?: Set<object>, until?: object, hideSelection?: boolean, target?: HTMLCanvasElement, rawMode?: boolean }} opts rawMode skips the document-mode renderer
   */
  composite(doc, opts = {}) {
    const rect = opts.rect ? intersectRect(opts.rect, doc.bounds) ?? { x: 0, y: 0, width: 1, height: 1 } : doc.bounds;
    // adjustment margins (I.4): kinds that read a neighbourhood see the same pixels in a partial repaint as in a full
    // one, so the work rect grows by their margins (clamped to the document) and the requested rect is cut out
    const margin = opts.rect && !opts.noMargin ? adjustmentMargin(doc) : 0;
    if (margin > 0) {
      const grown = intersectRect({ x: rect.x - margin, y: rect.y - margin, width: rect.width + margin * 2, height: rect.height + margin * 2 }, doc.bounds);
      if (grown && (grown.width > rect.width || grown.height > rect.height)) {
        const big = this.composite(doc, { ...opts, rect: grown, target: null, noMargin: true });
        const out = opts.target ?? createCanvas(rect.width, rect.height);
        const octx = out.getContext('2d', { willReadFrequently: true });
        octx.setTransform(1, 0, 0, 1, 0, 0);
        octx.clearRect(0, 0, out.width, out.height);
        octx.drawImage(big, grown.x - rect.x, grown.y - rect.y);
        return out;
      }
    }
    const isFull = !opts.rect && !opts.skip && !opts.until && !opts.target && !opts.rawMode;
    // layer.touch() bumps the root's version without a document change event (brush strokes), so both count
    if (isFull && this.full && this.full.version === doc.version && this.full.rootVersion === doc.root.version && this.full.canvas.width === doc.width && this.full.canvas.height === doc.height) return this.full.canvas;
    if (isFull && REPAINT.reuse) return this.compositeView(doc, opts);
    const canvas = opts.target ?? createCanvas(rect.width, rect.height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.translate(-rect.x, -rect.y);
    this.drawChildren(ctx, doc.root, rect, doc, opts);
    ctx.restore();
    // image modes other than RGB post-process the output (registerModeRenderer); mode changes bump doc.version
    const modeRender = doc.mode && doc.mode !== 'rgb' ? MODE_RENDERERS.get(doc.mode) : null;
    if (modeRender && !opts.rawMode) modeRender(doc, canvas, rect, opts);
    if (isFull) this.full = { version: doc.version, rootVersion: doc.root.version, canvas };
    return canvas;
  }

  /**
   * The full composite through the repaint caches (REPAINT; ARCHITECTURE.md "Repaint caches"). The root's draw units
   * are described (planOf) and compared with those of the last full composite (repaint-plan.js diffPlans):
   * unchanged, the last composite stands; a change confined to a box is composited over that box alone and pasted
   * into a copy of the last composite; anything else is composited from the lowest unit that changed, on a copy of the
   * cached composite of the units below it when that cache matches them. Every path gives a full composite's pixels.
   */
  compositeView(doc, opts) {
    const rect = doc.bounds;
    const modeRender = doc.mode && doc.mode !== 'rgb' ? MODE_RENDERERS.get(doc.mode) : null;
    const plan = this.planOf(doc);
    const prev = this.records;
    const fullOk = this.full && this.full.canvas.width === doc.width && this.full.canvas.height === doc.height;
    // a mode renderer reads document settings that are not in the plan (duotone inks, a colour table): its documents
    // keep the version check above and only use the cached prefix
    let diff = diffPlans(prev, plan);
    if (!fullOk || modeRender) diff = { kind: 'full', from: diff.kind === 'same' ? plan.units.length : diff.from };
    const settle = (canvas) => {
      this.full = { version: doc.version, rootVersion: doc.root.version, canvas };
      this.hints.clear();
      return canvas;
    };
    if (diff.kind === 'same') {
      this.lastPath = 'same'; // which path the last full composite took: 'same', 'region' or 'full' (tests)
      this.records = plan;
      return settle(this.full.canvas);
    }
    if (diff.kind === 'region' && REPAINT.region && plan.regionOk) {
      const changed = intersectBox(outerRect(diff.rect), rect);
      if (!changed) {
        this.lastPath = 'same';
        this.records = plan;
        return settle(this.full.canvas);
      }
      // an adjustment layer that reads around a pixel (margin, I.4) carries a change that far: Clarity above an edited
      // shape changes the pixels next to it too
      const m = adjustmentMargin(doc);
      const r = intersectBox({ x: changed.x - m, y: changed.y - m, width: changed.width + m * 2, height: changed.height + m * 2 }, rect);
      if (r.width * r.height <= REGION_MAX * rect.width * rect.height) {
        const part = this.composite(doc, { rect: r });
        // the boxes as drawn (a style render may reach past its padding estimate): a change outside the region means
        // it was too small, and the whole composite is redone
        const after = this.planOf(doc);
        if (insideRegion(prev, after, changed)) {
          this.lastPath = 'region';
          const out = this.backBuffer(doc);
          const g = out.getContext('2d', { willReadFrequently: true });
          g.setTransform(1, 0, 0, 1, 0, 0);
          g.globalCompositeOperation = 'copy';
          g.drawImage(this.full.canvas, 0, 0);
          g.globalCompositeOperation = 'source-over';
          g.clearRect(r.x, r.y, r.width, r.height);
          g.drawImage(part, r.x, r.y);
          this.patchPrefix(doc, prev, after, r);
          this.records = after;
          this.regionRuns++;
          return settle(out);
        }
      }
    }
    const from = diff.kind === 'region' || diff.kind === 'full' ? diff.from : 0;
    this.lastPath = 'full';
    const canvas = this.backBuffer(doc);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // the cached composite of the units below the first change, when it still matches them
    let start = 0;
    const snap = this.prefixFor(plan, from);
    if (snap) {
      ctx.drawImage(snap.canvas, 0, 0);
      start = snap.at;
      this.prefixHits++;
    }
    // where to keep a new one: below the unit that changed (the next edit is most likely the same layer), or below
    // the active layer's unit on a first composite
    const at = prev ? from : unitOf(plan, doc.active);
    // (a view's compositor only, once it has composited before: a one-off composite, an export's or a smart object's
    // source, has no next edit to serve)
    const capture = REPAINT.prefix && this.view && prev && at > start && at < plan.units.length ? plan.units[at].start : -1;
    const wasUnready = this.unready;
    this.unready = false;
    ctx.save();
    ctx.translate(-rect.x, -rect.y);
    this.drawChildren(ctx, doc.root, rect, doc, opts, {
      from: start < plan.units.length ? plan.units[start].start : doc.root.children.length,
      captureAt: capture,
      capture: () => this.capturePrefix(canvas, plan, at, doc),
    });
    ctx.restore();
    this.unready = wasUnready || this.unready;
    if (modeRender) modeRender(doc, canvas, rect, opts);
    this.records = this.planOf(doc);
    this.fullRuns++;
    return settle(canvas);
  }

  /**
   * After a region repaint: when the edit reached into the units the cached prefix holds, the same region of the
   * prefix is composited again (up to the unit it stops at) and pasted in, so the cache stays good for the next edit
   * higher up (an adjustment's slider after a brush stroke on a layer below it).
   */
  patchPrefix(doc, prev, after, r) {
    if (!REPAINT.prefix) return;
    for (const snap of this.snaps) {
      if (snap.at >= after.units.length || !samePrefix(snap.keys, prev, snap.at)) continue;
      if (samePrefix(snap.keys, after, snap.at)) continue;
      const below = this.composite(doc, { rect: r, until: doc.root.children[after.units[snap.at].start] });
      const g = snap.canvas.getContext('2d', { willReadFrequently: true });
      g.clearRect(r.x, r.y, r.width, r.height);
      g.drawImage(below, r.x, r.y);
      snap.keys = { global: after.global, units: after.units.slice(0, snap.at) };
    }
  }

  /** Keeps `canvas` (the document-sized target, holding units [0, at) of `plan`) as a cached prefix. */
  capturePrefix(canvas, plan, at, doc) {
    // a style render still waiting for a pattern is not cached, and neither is a prefix that holds one
    if (this.unready) return;
    // the least recently used cache gives its canvas (or the one at the same unit, now out of date)
    const list = this.snaps.filter((p) => p.at !== at && p.canvas.width === doc.width && p.canvas.height === doc.height);
    const old = this.snaps.find((p) => p.at === at) ?? (list.length >= PREFIX_SNAPS ? list.pop() : null);
    const c = old && old.canvas.width === doc.width && old.canvas.height === doc.height ? old.canvas : createCanvas(doc.width, doc.height);
    const g = c.getContext('2d', { willReadFrequently: true });
    g.globalCompositeOperation = 'copy';
    g.drawImage(canvas, 0, 0);
    g.globalCompositeOperation = 'source-over';
    this.snaps = [{ at, keys: { global: plan.global, units: plan.units.slice(0, at) }, canvas: c }, ...list.filter((p) => p !== old)].slice(0, PREFIX_SNAPS);
  }

  /** The cached prefix to start a composite from: the highest one at or below unit `from` that still matches. */
  prefixFor(plan, from) {
    if (!REPAINT.prefix) return null;
    let best = null;
    for (const p of this.snaps) if (p.at > 0 && p.at <= from && (!best || p.at > best.at) && samePrefix(p.keys, plan, p.at)) best = p;
    if (best) this.snaps = [best, ...this.snaps.filter((p) => p !== best)];
    return best;
  }

  /**
   * The view-scale preview while a gesture runs (canvas-view.js PREVIEW): what has changed since the last full
   * composite, over the part of `rect` (the visible document rect) it can reach, with the layers at full resolution
   * and the root's adjustment layers run on a copy scaled to `scale` (the view's), which is what costs on a large
   * document. Nothing is cached from it: the last full composite, the plan and the prefix stay those of exact
   * pixels, and the view composites exactly when the gesture ends. Returns { canvas, x, y } to draw over the last
   * full composite (canvas null: nothing visible changed), or null when there is no full composite to start from.
   */
  preview(doc, { rect, scale = 1 }) {
    const vis = rect && intersectBox(outerRect(rect), doc.bounds);
    const modeRender = doc.mode && doc.mode !== 'rgb' ? MODE_RENDERERS.get(doc.mode) : null;
    if (!vis || !this.full || !this.records || modeRender || this.full.canvas.width !== doc.width || this.full.canvas.height !== doc.height) return null;
    const plan = this.planOf(doc);
    const diff = diffPlans(this.records, plan);
    if (diff.kind === 'same') return { canvas: null, x: 0, y: 0, changed: false };
    let r = vis;
    if (diff.kind === 'region' && plan.regionOk && REPAINT.region) {
      const m = adjustmentMargin(doc);
      const c = outerRect(diff.rect);
      const grown = intersectBox(c && { x: c.x - m, y: c.y - m, width: c.width + m * 2, height: c.height + m * 2 }, doc.bounds);
      // a small region (a brush dab) costs little at full resolution: composited exactly
      if (!grown || grown.width * grown.height <= PREVIEW_EXACT_AREA) {
        this.composite(doc);
        return { canvas: null, x: 0, y: 0, changed: false };
      }
      r = intersectBox(grown, vis);
      if (!r) return { canvas: null, x: 0, y: 0, changed: true };
    }
    // the same frame again (the selection's marching ants repaint the view): the same preview
    const key = `${oid(this.records)}|${r.x},${r.y},${r.width},${r.height}|${scale}|${plan.units.map((u) => u.pkey + u.vkey).join('/')}`;
    if (this.lastPreview?.key === key) return this.lastPreview.result;
    // one buffer for the previews of a gesture (the view draws each one at once; the next frame redraws it)
    const canvas = this.previewCanvas?.width === r.width && this.previewCanvas.height === r.height ? this.previewCanvas : (this.previewCanvas = createCanvas(r.width, r.height));
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, r.width, r.height);
    let start = 0;
    const snap = this.prefixFor(plan, diff.from);
    if (snap) {
      ctx.drawImage(snap.canvas, r.x, r.y, r.width, r.height, 0, 0, r.width, r.height);
      start = snap.at;
    }
    // the units below the change are drawn exactly (only the changed unit and those above it are scaled), so when
    // the preview covers the whole document they become a cached prefix like a full composite's
    const fromChild = diff.from < plan.units.length ? plan.units[diff.from].start : doc.root.children.length;
    const whole = r.x === 0 && r.y === 0 && r.width === doc.width && r.height === doc.height;
    const at = diff.from;
    const wasUnready = this.unready;
    this.unready = false;
    ctx.save();
    ctx.translate(-r.x, -r.y);
    this.drawChildren(ctx, doc.root, r, doc, { previewScale: Math.max(0.05, Math.min(1, scale)), scaleFrom: fromChild }, {
      from: start < plan.units.length ? plan.units[start].start : doc.root.children.length,
      captureAt: REPAINT.prefix && whole && at > start && at < plan.units.length ? fromChild : -1,
      capture: () => this.capturePrefix(canvas, plan, at, doc),
    });
    ctx.restore();
    this.unready = wasUnready || this.unready;
    this.previewRuns++;
    const result = { canvas, x: r.x, y: r.y, changed: true };
    this.lastPreview = { key, result };
    return result;
  }

  /**
   * Adjustment layers of the root in a preview: the target scaled down to the view's resolution, adjusted there (one
   * pass for the run, masks scaled alike) and scaled back up into the target. An approximation for the moments of a
   * drag; kinds that read around a pixel read a wider neighbourhood at this scale.
   */
  drawAdjustmentsScaled(ctx, layers, rect, doc, scale) {
    const sw = Math.max(1, Math.round(rect.width * scale)), sh = Math.max(1, Math.round(rect.height * scale));
    const small = createCanvas(sw, sh);
    const g = small.getContext('2d', { willReadFrequently: true });
    g.imageSmoothingQuality = 'medium';
    g.drawImage(ctx.canvas, 0, 0, rect.width, rect.height, 0, 0, sw, sh);
    const below = g.getImageData(0, 0, sw, sh);
    const r = { x: 0, y: 0, width: sw, height: sh };
    for (const layer of layers) {
      const img = { width: sw, height: sh, data: new Uint8ClampedArray(below.data) };
      applyAdjustment(img, layer.kind, layer.params, null, { origin: { x: rect.x, y: rect.y }, docWidth: doc?.width ?? rect.width, docHeight: doc?.height ?? rect.height, scale });
      let mask = maskCanvasFor(layer, doc, { purpose: 'composite' }); // mask (K.1)
      if (mask && this.whiteOver(mask, layer, rect)) mask = null;
      let m = null;
      if (mask) {
        m = createCanvas(sw, sh);
        m.getContext('2d').drawImage(mask, rect.x, rect.y, rect.width, rect.height, 0, 0, sw, sh);
      }
      this.mixAdjustedData(layer, below, img, r, m);
    }
    g.putImageData(below, 0, 0);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'copy';
    ctx.imageSmoothingQuality = 'medium';
    ctx.drawImage(small, 0, 0, sw, sh, 0, 0, rect.width, rect.height);
    ctx.restore();
  }

  /**
   * A document-sized canvas for the next full composite: the one before the current, so the canvas a caller was
   * handed stays as it was until the composite after next (a copy is what export and history keep anyway).
   */
  backBuffer(doc) {
    if (!this.view) return createCanvas(doc.width, doc.height);
    const cur = this.full?.canvas ?? null;
    let b = this.spare;
    if (!b || b === cur || b.width !== doc.width || b.height !== doc.height) b = createCanvas(doc.width, doc.height);
    this.spare = cur && cur.width === doc.width && cur.height === doc.height ? cur : null;
    return b;
  }

  /**
   * Says that `layer`'s pixels changed only inside `rect` (document coordinates) since the last composite: a brush dab
   * (canvas-view.js passes the dirty rects of a stroke). The hint holds for the layer's version as it is now, so a
   * touch that comes after it without a hint of its own falls back to the layer's whole box.
   */
  hintPixels(layer, rect) {
    if (!layer || !rect) return;
    const h = this.hints.get(layer);
    const r = rect.width > 0 && rect.height > 0 ? outerRect(rect) : null;
    this.hints.set(layer, { rect: h ? unionBox(h.rect, r) : r, version: layer.version });
    // the layer's content box grows by the dab instead of being measured again (a superset is all a repaint needs);
    // only when this dab's touch is the one change since it was measured
    const e = layer.type === 'raster' ? this.boxes?.get(layer.canvas) : null;
    if (e && e.version === layer.version - 1) {
      if (r) e.box = unionBox(e.box, intersectBox({ x: r.x - layer.x, y: r.y - layer.y, width: r.width, height: r.height }, { x: 0, y: 0, width: layer.canvas.width, height: layer.canvas.height }));
      e.version = layer.version;
    }
  }

  /**
   * The root's draw units for repaint-plan.js: a unit is a layer drawChildren draws, with the clipped layers it takes
   * along. See repaint-plan.js for the fields; `start` is the unit's first child index, `regionOk` whether a partial
   * composite gives a full one's pixels for this document (no Dissolve layer, no adjustment kind that measures the
   * whole image, no mode renderer).
   */
  planOf(doc) {
    const kids = doc.root.children;
    const angle = doc.globalLight?.angle ?? 120, altitude = doc.globalLight?.altitude ?? 30;
    const global = `${doc.width}x${doc.height}|${doc.mode ?? 'rgb'}|${doc.depth ?? 8}|${angle},${altitude}|${oid(backgroundOf(doc))}`;
    const prev = this.records?.global === global ? this.records : null;
    // a first composite (an export's own compositor) is never compared with: its boxes need no measuring
    this.measure = !!this.records;
    const units = [];
    const state = { regionOk: !(doc.mode && doc.mode !== 'rgb' && MODE_RENDERERS.has(doc.mode)) };
    let nonClip = false;
    for (let i = 0; i < kids.length; i++) {
      const base = kids[i];
      const isStart = !(base.clip && nonClip);
      if (!base.clip) nonClip = true;
      if (!isStart) continue;
      let j = i + 1;
      while (j < kids.length && kids[j].clip) j++;
      const k = { p: '', v: '', layers: [] };
      for (let n = i; n < j; n++) keyOf(kids[n], k, base.visible && kids[n].visible, this, state);
      const id = kids.slice(i, j).map((l) => oid(l)).join(',');
      const unit = { start: i, id, pkey: k.p, vkey: k.v, box: this.drawBox(base), hint: undefined };
      unit.hint = this.hintFor(unit, k.layers, prev, base);
      units.push(unit);
    }
    const versions = new Map();
    for (const l of doc.layers()) versions.set(l, l.version);
    return { global, units, regionOk: state.regionOk, versions };
  }

  /**
   * The dirty rect of a unit whose layers were only touched, every touch with a pixel hint (hintPixels): undefined
   * when the hints do not cover the change. Effects, feathered masks and clipped adjustments read around a pixel, so
   * a unit holding one takes its whole box instead.
   */
  hintFor(unit, layers, prev, base) {
    if (!prev || !this.hints.size || base.isGroup) return undefined;
    let rect = null, moved = false;
    for (const l of layers) {
      if (hasEnabledStyles(l.styles) || maskFeather(l.mask ?? {}) > 0 || (l.vectorMask && maskFeather(l.vectorMask) > 0)) return undefined;
      if (l !== base && l.type === 'adjustment') return undefined;
      if (prev.versions.get(l) === l.version) continue;
      const h = this.hints.get(l);
      if (!h || h.version !== l.version) return undefined;
      moved = true;
      rect = unionBox(rect, h.rect);
    }
    return moved ? rect ?? { x: 0, y: 0, width: 0, height: 0 } : undefined;
  }

  /** The document box outside which a layer leaves the backdrop alone (repaint-plan.js `box`). */
  drawBox(layer) {
    if (!layer.visible) return null;
    if (layer.type === 'adjustment') return ALL;
    let b = null;
    if (layer.isGroup) {
      // a pass-through group's fade and an isolated group's per-pixel blend cover their whole repaint rect, but they
      // give the backdrop back unchanged wherever no child draws
      for (const c of layer.children) {
        const cb = this.drawBox(c);
        if (cb === ALL) return ALL;
        b = unionBox(b, cb);
      }
    } else if (layer.type === 'raster') {
      b = this.contentBox(layer);
    } else {
      const src = this.layerSource(layer);
      if (src) b = { x: src.x, y: src.y, width: src.canvas.width, height: src.canvas.height };
    }
    if (!b) return null;
    if (hasEnabledStyles(layer.styles)) {
      const pad = Math.ceil(stylePadding(layer.styles)) + 1;
      b = { x: b.x - pad, y: b.y - pad, width: b.width + pad * 2, height: b.height + pad * 2 };
      // the render as cached, when it is current: it is what was drawn
      // (where it has alpha: the render covers the whole source canvas, often document-sized)
      const e = this.styleCache.get(layer);
      if (e && e.version === layer.version) {
        const drawn = (c, x, y) => {
          const f = this.frozenBounds(c, x, y);
          return f === undefined ? { x, y, width: c.width, height: c.height } : f;
        };
        b = unionBox(b, drawn(e.canvas, e.x, e.y));
        if (e.layer) b = unionBox(b, drawn(e.layer, e.x, e.y));
        for (const part of e.parts ?? []) b = unionBox(b, { x: part.x, y: part.y, width: part.canvas.width, height: part.canvas.height });
      }
    }
    return outerRect(b);
  }

  /**
   * Where a raster layer has pixels (document coordinates; null when it has none). A large canvas is measured, once
   * per canvas and layer version: layers are often document-sized around a small subject, and transparent pixels
   * leave the backdrop alone in every mode and blending option, so an edit repaints the subject's box only.
   */
  contentBox(layer) {
    const c = layer.canvas;
    if (c.width * c.height < 1 << 20 || !this.measure) return { x: layer.x, y: layer.y, width: c.width, height: c.height };
    const cache = this.boxes ?? (this.boxes = new WeakMap()); // canvas -> { version, box }
    let hit = cache.get(c);
    if (!hit || hit.version !== layer.version) {
      hit = { version: layer.version, box: alphaBox(c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height)) };
      cache.set(c, hit);
    }
    return hit.box ? { x: layer.x + hit.box.x, y: layer.y + hit.box.y, width: hit.box.width, height: hit.box.height } : null;
  }

  /** Renders the group's children into ctx (ctx already translated so document coordinates apply). `range` (the
   * root, compositeView): start at child `from`, and call `capture()` just before child `captureAt` is drawn. */
  drawChildren(ctx, group, rect, doc, opts, range = null) {
    const kids = group.children;
    // which children are drawn as layers of their own (a clipped layer goes with its base below; without any base it
    // sits at the bottom and is an ordinary layer)
    const drawn = (i) => {
      const l = kids[i];
      if (!l.visible || opts.skip?.has(l)) return false;
      if (l.clip) for (let k = 0; k < i; k++) if (!kids[k].clip) return false;
      return true;
    };
    for (let i = range?.from ?? 0; i < kids.length; i++) {
      const layer = kids[i];
      if (range && i === range.captureAt) range.capture();
      if (opts.until && layer === opts.until) return true;
      if (!drawn(i)) continue;
      const scaled = opts.previewScale < 1 && group === doc.root && i >= (opts.scaleFrom ?? 0);
      if (layer.type === 'adjustment' && (REPAINT.chain || scaled)) {
        // consecutive adjustment layers: one read and one write of the target for all of them
        const chain = [layer];
        let j = i + 1;
        for (; j < kids.length; j++) {
          const k = kids[j];
          if ((range && j === range.captureAt) || (opts.until && k === opts.until)) break;
          if (!scaled && opts.previewScale < 1 && group === doc.root && j === opts.scaleFrom) break; // scaled from there
          if (!drawn(j)) continue;
          if (k.type !== 'adjustment') break;
          chain.push(k);
        }
        if (scaled) {
          this.drawAdjustmentsScaled(ctx, chain, rect, doc, opts.previewScale);
          i = j - 1;
          continue;
        }
        if (chain.length > 1 && softCanvas(ctx)) {
          this.drawAdjustmentChain(ctx, chain, rect, doc);
          i = j - 1;
          continue;
        }
      }
      // clipping chain: this layer plus following clip layers
      let j = i + 1;
      while (j < kids.length && kids[j].clip) j++;
      const clipped = kids.slice(i + 1, j).filter((l) => l.visible && !opts.skip?.has(l));
      const stop = this.drawLayer(ctx, layer, clipped, rect, doc, opts);
      if (stop) return true;
    }
    return false;
  }

  /** Draws one layer (with its clipped layers) into ctx. Returns true when opts.until was reached inside a group. */
  drawLayer(ctx, layer, clipped, rect, doc, opts) {
    if (layer.type === 'adjustment') {
      this.drawAdjustment(ctx, layer, rect, doc);
      return false;
    }
    if (layer.isGroup) {
      // only Pass Through lets the children blend with what is below the group; Normal isolates them. A pass-through
      // group with effects or advanced blending composites as an isolated group, as Photoshop does (K.3)
      const styled = hasEnabledStyles(layer.styles);
      const passThrough = layer.blend === 'pass-through' && !clipped.length && !styled && !blendingOf(layer);
      if (passThrough && layer.opacity >= 1 && !hasEffectiveMask(layer)) return this.drawGroupChildren(ctx, layer, rect, doc, opts); // mask (K.1)
      if (passThrough) {
        // pass through with opacity or a mask: the children blend with the backdrop, then the result is
        // faded back towards that backdrop (so an adjustment layer inside keeps working at 50%)
        const tmp = createCanvas(rect.width, rect.height);
        const tctx = tmp.getContext('2d', { willReadFrequently: true });
        tctx.drawImage(ctx.canvas, 0, 0);
        tctx.translate(-rect.x, -rect.y);
        const stop = this.drawGroupChildren(tctx, layer, rect, doc, opts);
        tctx.setTransform(1, 0, 0, 1, 0, 0);
        this.lerpInto(ctx, tmp, rect, layer.opacity, maskCanvasFor(layer, doc, { purpose: 'composite' })); // mask (K.1)
        return stop;
      }
      if (styled) {
        // effects need the whole content, not only the repaint rect: rendered once over it and cached (K.3)
        const src = this.styledGroupSource(layer, doc, opts);
        if (src) this.finishLayer(ctx, layer, src.canvas, src.x, src.y, clipped, rect, doc, opts);
        return src?.stop ?? false;
      }
      const tmp = createCanvas(rect.width, rect.height);
      const tctx = tmp.getContext('2d', { willReadFrequently: true });
      tctx.translate(-rect.x, -rect.y);
      const stop = this.drawChildren(tctx, layer, rect, doc, opts);
      tctx.setTransform(1, 0, 0, 1, 0, 0);
      this.finishLayer(ctx, layer, tmp, rect.x, rect.y, clipped, rect, doc, opts);
      return stop;
    }
    const src = this.layerSource(layer);
    if (!src) return false;
    const srcRect = { x: src.x, y: src.y, width: src.canvas.width, height: src.canvas.height };
    const pad = layer.styles ? stylePadding(layer.styles) : 0;
    const vis = intersectRect({ x: srcRect.x - pad, y: srcRect.y - pad, width: srcRect.width + pad * 2, height: srcRect.height + pad * 2 }, rect);
    if (!vis) return false;
    // a large source seen through a small rect (a repaint of a few pixels of a document-sized layer or fill): without
    // effects, which need the whole content, every later step (mask, fill, clipping, blend) is per pixel, so it runs
    // on the part in the rect only. A clipped adjustment or group reads the base's whole box (clipGroup), so a base
    // with one keeps its source whole
    const local = !hasEnabledStyles(layer.styles) && !clipped.some((c) => c.type === 'adjustment' || c.isGroup);
    if (local && vis.width * vis.height * 2 < srcRect.width * srcRect.height) {
      const part = createCanvas(vis.width, vis.height);
      part.getContext('2d').drawImage(src.canvas, src.x - vis.x, src.y - vis.y);
      this.finishLayer(ctx, layer, part, vis.x, vis.y, clipped, rect, doc, opts);
      return false;
    }
    this.finishLayer(ctx, layer, src.canvas, src.x, src.y, clipped, rect, doc, opts);
    return false;
  }

  /**
   * Applies clipping layers, styles, mask, opacity and blend mode, then draws into ctx. `clipTo` ({ canvas, x, y }:
   * the base's shape) cuts the result when the layer is clipped to a base whose Blend Clipped Layers as Group is off.
   */
  finishLayer(ctx, layer, canvas, x, y, clipped, rect, doc, opts, clipTo = null) {
    const bl = blendingOf(layer);
    // K.3: advanced blending options take the per-pixel path; the defaults keep 0.3's order and Canvas fast path
    if (bl) return this.finishAdvanced(ctx, layer, canvas, x, y, clipped, rect, doc, opts, bl, clipTo);
    let work = canvas, wx = x, wy = y;
    if (clipped.length) work = this.clipGroup(work, wx, wy, clipped, doc, opts, layer);
    const styled = hasEnabledStyles(layer.styles);
    if (layer.fillOpacity < 1 && !layer.isGroup && !styled) {
      const faded = createCanvas(work.width, work.height);
      const fctx = faded.getContext('2d');
      fctx.globalAlpha = layer.fillOpacity;
      fctx.drawImage(work, 0, 0);
      work = faded;
    }
    // the mask shapes the layer before its effects (Photoshop's default: a stroke or shadow follows the mask edge)
    // (K.3: the advanced path splits the parts around the styles for the two "hides effects" boxes)
    const masked = hasEffectiveMask(layer); // mask (K.1)
    if (masked) work = applyLayerMask(work, wx, wy, layer, doc); // mask (K.1)
    if (styled) {
      // edits on clipped layers only bump their own versions: they are part of the style cache key
      const clipKey = clipped.length ? clipped.map((c) => `${c.id}:${c.version}`).join(',') : '';
      const out = this.styledCanvas(layer, work, wx, wy, doc, { masked, clipKey, maskKey: maskCacheKey(layer), split: needsSplit(layer) }); // mask (K.1)
      if (out?.parts) {
        // the exterior effects blend with the backdrop in their own modes, the content in the layer's
        const parts = clipTo ? out.parts.map((p) => ({ ...p, canvas: clipToAlpha(p.canvas, p.x, p.y, clipTo) })) : out.parts;
        const content = clipTo ? clipToAlpha(out.layer, out.x, out.y, clipTo) : out.layer;
        this.drawStack(ctx, layer, parts, content, out.x, out.y, rect, clipTo ? null : out.layerBox);
        return;
      }
      if (out) {
        work = out.canvas;
        wx = out.x;
        wy = out.y;
      }
    }
    if (clipTo) work = clipToAlpha(work, wx, wy, clipTo);
    this.drawWork(ctx, layer, work, wx, wy, rect);
  }

  /**
   * Photoshop's order for a layer with exterior effects: each part (drop shadow, outer glow, outer bevel, outer
   * stroke; bottom first, { canvas, x, y, blend, opacity }) is composited onto the backdrop with its own mode and
   * opacity, then the content (the layer with its interior effects, at x, y) with the layer's mode, and the layer's
   * opacity fades the result from the backdrop as one (on a copy of the backdrop, which is then lerped back). Only the
   * box the layer draws into is touched; `box` (document coordinates) is where the content has alpha (null: unknown).
   */
  drawStack(ctx, layer, parts, content, x, y, rect, box = null) {
    const opacity = Math.max(0, Math.min(1, layer.opacity ?? 1));
    if (!(opacity > 0)) return;
    // box: null when unknown (the whole content canvas), empty when the content has no alpha (Fill 0 %)
    let area = !box ? { x, y, width: content.width, height: content.height } : box.width && box.height ? box : null;
    for (const p of parts) {
      const pr = { x: p.x, y: p.y, width: p.canvas.width, height: p.canvas.height };
      area = area ? unionRect(area, pr) : pr;
    }
    const r = area && intersectRect(area, rect);
    if (!r) return;
    const mode = modeOf(layer);
    // Dissolve speckles the layer at its opacity (no fade afterwards); the parts are drawn at theirs times it
    const dissolve = mode === 'dissolve';
    if (dissolve || opacity >= 1) {
      // nothing to fade: the parts and the content go straight onto the backdrop
      for (const p of parts) this.drawBlended(ctx, p.blend, p.opacity * (dissolve ? opacity : 1), p.canvas, p.x, p.y, rect);
      this.drawBlended(ctx, mode, dissolve ? opacity : 1, content, x, y, rect);
      return;
    }
    // two scratch canvases kept between calls (a repaint of ten faded styled layers would otherwise allocate twenty)
    const [tmp, result] = this.scratchPair(r.width, r.height);
    const g = tmp.getContext('2d', { willReadFrequently: true });
    g.clearRect(0, 0, r.width, r.height);
    g.drawImage(ctx.canvas, rect.x - r.x, rect.y - r.y);
    g.save();
    g.translate(-r.x, -r.y);
    for (const p of parts) this.drawBlended(g, p.blend, p.opacity, p.canvas, p.x, p.y, r);
    this.drawBlended(g, mode, 1, content, x, y, r);
    g.restore();
    // one lerp from the backdrop, in premultiplied space: backdrop × (1 - opacity) + result × opacity
    const m = result.getContext('2d', { willReadFrequently: true });
    m.clearRect(0, 0, r.width, r.height);
    m.save();
    m.globalAlpha = 1 - opacity;
    m.drawImage(ctx.canvas, rect.x - r.x, rect.y - r.y);
    m.globalAlpha = opacity;
    m.globalCompositeOperation = 'lighter';
    m.drawImage(tmp, 0, 0, r.width, r.height, 0, 0, r.width, r.height);
    m.restore();
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(r.x - rect.x, r.y - rect.y, r.width, r.height);
    ctx.drawImage(result, 0, 0, r.width, r.height, r.x - rect.x, r.y - rect.y, r.width, r.height);
    ctx.restore();
  }

  /** Two canvases of at least w x h for drawStack (grown when too small; their contents are scratch). */
  scratchPair(w, h) {
    const s = this.scratch;
    if (s && s[0].width >= w && s[0].height >= h) return s;
    const W = Math.max(w, s?.[0].width ?? 0), H = Math.max(h, s?.[0].height ?? 0);
    this.scratch = [createCanvas(W, H), createCanvas(W, H)];
    return this.scratch;
  }

  /** Draws a finished layer image with the layer's blend mode and opacity (Canvas when it can, else per pixel). */
  drawWork(ctx, layer, work, wx, wy, rect) {
    this.drawBlended(ctx, modeOf(layer), layer.opacity, work, wx, wy, rect);
  }

  /** Draws `work` (at document wx, wy) into ctx (translated to document space, its canvas holding rect) in a mode. */
  drawBlended(ctx, mode, opacity, work, wx, wy, rect) {
    const op = CANVAS_BLEND[mode] ?? (SIMPLE_OVER.has(mode) ? 'source-over' : null);
    if (op) {
      ctx.save();
      ctx.globalAlpha = opacity;
      ctx.globalCompositeOperation = op;
      ctx.drawImage(work, wx, wy);
      ctx.restore();
      return;
    }
    // per-pixel fallback on the overlap of the layer and the rect
    const overlap = intersectRect({ x: wx, y: wy, width: work.width, height: work.height }, rect);
    if (!overlap) return;
    const dst = ctx.getImageData(overlap.x - rect.x, overlap.y - rect.y, overlap.width, overlap.height);
    const srcCanvas = createCanvas(overlap.width, overlap.height);
    srcCanvas.getContext('2d').drawImage(work, wx - overlap.x, wy - overlap.y);
    const src = srcCanvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, overlap.width, overlap.height);
    blendImages(mode, src, dst, opacity);
    ctx.putImageData(dst, overlap.x - rect.x, overlap.y - rect.y);
  }

  /** The base composited with its clipped layers (Blend Clipped Layers as Group, 0.3's clipping), cut to its alpha. */
  clipGroup(work, wx, wy, clipped, doc, opts, base = null) {
    // composite clipped layers onto a copy limited to the base alpha
    const copy = createCanvas(work.width, work.height);
    const cctx = copy.getContext('2d', { willReadFrequently: true });
    // the clipped layers blend with the base's colour at full strength and the group then takes the base's alpha
    // once: on the base as it is, its alpha would count twice (a 50 % edge pixel drawn at 25 % where nothing covers it)
    cctx.drawImage(this.opaqueBase(work, base), 0, 0);
    cctx.translate(-wx, -wy);
    const sub = { x: wx, y: wy, width: work.width, height: work.height };
    for (const c of clipped) {
      if (c.type === 'adjustment') {
        this.drawAdjustment(cctx, c, sub, doc);
        continue;
      }
      const cs = c.isGroup ? this.clippedGroupSource(c, sub, doc, opts) : this.layerSource(c);
      if (!cs) continue;
      this.finishLayer(cctx, c, cs.canvas, cs.x, cs.y, [], sub, doc, opts);
    }
    cctx.setTransform(1, 0, 0, 1, 0, 0);
    // keep only where the base had alpha
    cctx.globalCompositeOperation = 'destination-in';
    cctx.drawImage(work, 0, 0);
    return copy;
  }

  /**
   * `work` (the base's pixels) with every pixel that has any alpha made opaque, for clipGroup. A pass over every pixel
   * is too slow for each composite of a large document (a stroke on a clipped layer recomposites the base each time):
   * it is cached on the canvas and the base layer's version, as styledCanvas is, so only an edit of the base itself
   * redoes it. A fresh canvas (a group, a faded source) is measured each time and its entry is dropped with it.
   */
  opaqueBase(work, base) {
    const cache = this.opaque ?? (this.opaque = new WeakMap()); // base canvas -> { layer, version, w, h, canvas }
    const hit = cache.get(work);
    if (hit && base && hit.layer === base && hit.version === base.version && hit.w === work.width && hit.h === work.height) return hit.canvas;
    const out = createCanvas(work.width, work.height);
    const octx = out.getContext('2d', { willReadFrequently: true });
    octx.drawImage(work, 0, 0);
    const img = octx.getImageData(0, 0, out.width, out.height);
    for (let p = 3; p < img.data.length; p += 4) if (img.data[p]) img.data[p] = 255;
    octx.putImageData(img, 0, 0);
    if (base) cache.set(work, { layer: base, version: base.version, w: work.width, h: work.height, canvas: out });
    return out;
  }

  /**
   * K.3: a layer whose blending options are not the defaults. Clipped layers (as a group, or each over the backdrop
   * cut to the base's shape), the mask parts before the effects, fill opacity, the effects with Blend Interior Effects
   * as Group and Transparency Shapes Layer, the mask parts after them; then knockout, Blend If and the channels per
   * pixel (blend-if.js compositeAdvanced) when one of them is set, else the ordinary draw.
   */
  finishAdvanced(ctx, layer, canvas, x, y, clipped, rect, doc, opts, bl, clipTo) {
    let work = canvas, wx = x, wy = y;
    const grouped = bl.clippedAsGroup !== false;
    if (clipped.length && grouped) work = this.clipGroup(work, wx, wy, clipped, doc, opts, layer);
    const styled = hasEnabledStyles(layer.styles);
    const parts = maskPartsAround(bl);
    // the mask parts whose "hides effects" box is off shape the layer before its effects (K.1 parts of K.3)
    const maskedBefore = !!parts.before && hasEffectiveMask(layer, parts.before); // mask (K.1)
    if (maskedBefore) work = applyLayerMask(work, wx, wy, layer, doc, { parts: parts.before }); // mask (K.1)
    // the layer's shape before its fill fades it: what knockout and Blend Clipped Layers outside the group use
    let shape = { canvas: work, x: wx, y: wy };
    if (layer.fillOpacity < 1 && !layer.isGroup && !styled) {
      const faded = createCanvas(work.width, work.height);
      const fctx = faded.getContext('2d');
      fctx.globalAlpha = layer.fillOpacity;
      fctx.drawImage(work, 0, 0);
      work = faded;
    }
    const blendIf = !isDefaultBlendIf(bl.blendIf);
    const knockout = bl.knockout === 'shallow' || bl.knockout === 'deep' ? bl.knockout : 'none';
    const perPixel = knockout !== 'none' || blendIf || restrictsChannels(bl.channels);
    // the exterior effects apart (styles.js split) when they blend in modes of their own, and on the per-pixel path,
    // where Blend If leaves them alone and the knockout comes between them and the content
    let fx = null, box = null;
    if (styled) {
      const clipKey = clipped.length && grouped ? clipped.map((c) => `${c.id}:${c.version}`).join(',') : '';
      const split = exteriorOf(layer).length > 0 && (perPixel || needsSplit(layer));
      const out = this.styledCanvas(layer, work, wx, wy, doc, {
        masked: maskedBefore, clipKey, maskKey: parts.before ? maskCacheKey(layer, parts.before) : 'none', // mask (K.1)
        interiorAsGroup: !!bl.interiorAsGroup, transparencyShapes: bl.transparencyShapes !== false, split,
      });
      if (out) {
        work = out.parts ? out.layer : out.canvas;
        fx = out.parts ?? null;
        box = out.parts ? out.layerBox : null;
        wx = out.x;
        wy = out.y;
      }
    }
    // the parts whose box is on hide the effects too: applied to everything the layer draws (K.1 parts of K.3)
    if (parts.after && hasEffectiveMask(layer, parts.after)) { // mask (K.1)
      work = applyLayerMask(work, wx, wy, layer, doc, { parts: parts.after }); // mask (K.1)
      if (fx) fx = fx.map((p) => ({ ...p, canvas: applyLayerMask(p.canvas, p.x, p.y, layer, doc, { parts: parts.after }) })); // mask (K.1)
      shape = { canvas: applyLayerMask(shape.canvas, shape.x, shape.y, layer, doc, { parts: parts.after }), x: shape.x, y: shape.y }; // mask (K.1)
      box = null;
    }
    if (clipTo) {
      work = clipToAlpha(work, wx, wy, clipTo);
      if (fx) fx = fx.map((p) => ({ ...p, canvas: clipToAlpha(p.canvas, p.x, p.y, clipTo) }));
      shape = { canvas: clipToAlpha(shape.canvas, shape.x, shape.y, clipTo), x: shape.x, y: shape.y };
      box = null;
    }
    if (!perPixel) {
      if (fx) this.drawStack(ctx, layer, fx, work, wx, wy, rect, box);
      else this.drawWork(ctx, layer, work, wx, wy, rect);
    } else {
      this.drawPixels(ctx, layer, { work, fx, shape, wx, wy, knockout, bl }, rect, doc, opts);
    }
    // Blend Clipped Layers as Group off: each clipped layer blends with the backdrop in its own mode, cut to the
    // base's shape (the base's fill opacity does not fade them)
    if (clipped.length && !grouped) {
      const base = clipTo ?? shape;
      for (const c of clipped) {
        if (c.type === 'adjustment') {
          this.drawClippedAdjustment(ctx, c, base, rect, doc);
          continue;
        }
        const cs = c.isGroup ? this.clippedGroupSource(c, rect, doc, opts) : this.layerSource(c);
        if (!cs) continue;
        this.finishLayer(ctx, c, cs.canvas, cs.x, cs.y, [], rect, doc, opts, base);
      }
    }
  }

  /** The per-pixel step of finishAdvanced: knockout, Blend If and channel restriction on the visible region. */
  drawPixels(ctx, layer, { work, fx = null, shape, wx, wy, knockout, bl }, rect, doc, opts) {
    let box = { x: wx, y: wy, width: work.width, height: work.height };
    if (knockout !== 'none') box = unionRect(box, { x: shape.x, y: shape.y, width: shape.canvas.width, height: shape.canvas.height });
    else if (layer.blend !== 'dissolve') {
      // without knockout nothing changes where the layer and its effects are transparent: a styled layer's cached
      // render is cut to where it has alpha, so a small shape on a document-sized canvas is not read and blended pixel
      // by pixel over the whole document on every composite (Dissolve's noise follows the pixel positions: left as is)
      const tight = this.frozenBounds(work, wx, wy);
      if (tight === null && !fx?.length) return;
      if (tight !== undefined) box = tight;
    }
    // the exterior parts are cropped to their pixels already
    if (fx) for (const p of fx) box = box ? unionRect(box, { x: p.x, y: p.y, width: p.canvas.width, height: p.canvas.height }) : { x: p.x, y: p.y, width: p.canvas.width, height: p.canvas.height };
    const r = box && intersectRect(box, rect);
    if (!r) return;
    const dst = ctx.getImageData(r.x - rect.x, r.y - rect.y, r.width, r.height);
    const layerImg = readRegion(work, wx, wy, r);
    const partImgs = fx ? fx.map((p) => ({ image: readRegion(p.canvas, p.x, p.y, r), blend: p.blend, opacity: p.opacity })) : null;
    let shapeAlpha = null, knock = null;
    if (knockout !== 'none') {
      shapeAlpha = this.shapeAlpha(shape, r, bl.transparencyShapes !== false);
      knock = this.knockBackdrop(layer, knockout, r, doc, opts);
    }
    compositeAdvanced({
      dst, layer: layerImg, parts: partImgs, knock, shape: shapeAlpha, knockout,
      blendIf: bl.blendIf, channels: bl.channels, mode: layer.isGroup && layer.blend === 'pass-through' ? 'normal' : layer.blend, opacity: layer.opacity,
    });
    ctx.putImageData(dst, r.x - rect.x, r.y - rect.y);
  }

  /**
   * The document box where `work` (a canvas at x, y) has alpha, when it is a render of the style cache (it never
   * changes, so the box is measured once); null when it is wholly transparent, undefined otherwise.
   */
  frozenBounds(work, x, y) {
    const frozen = this.frozen ?? (this.frozen = new WeakMap()); // style-cache canvas -> its alpha box (or null)
    if (!frozen.has(work)) return undefined;
    let b = frozen.get(work);
    if (b === false) {
      b = alphaBox(work.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, work.width, work.height));
      frozen.set(work, b);
    }
    return b ? { x: x + b.x, y: y + b.y, width: b.width, height: b.height } : null;
  }

  /** The layer's shape alpha (0..255 per pixel of r); with Transparency Shapes Layer off, its whole content box. */
  shapeAlpha(shape, r, transparencyShapes) {
    const out = new Uint8ClampedArray(r.width * r.height);
    if (transparencyShapes) {
      const d = readRegion(shape.canvas, shape.x, shape.y, r).data;
      for (let i = 0, p = 3; i < out.length; i++, p += 4) out[i] = d[p];
      return out;
    }
    const g = shape.canvas.getContext('2d', { willReadFrequently: true });
    const b = alphaBox(g.getImageData(0, 0, shape.canvas.width, shape.canvas.height));
    if (!b) return out;
    const box = intersectRect({ x: shape.x + b.x, y: shape.y + b.y, width: b.width, height: b.height }, r);
    if (!box) return out;
    for (let y = box.y; y < box.y + box.height; y++) out.fill(255, (y - r.y) * r.width + (box.x - r.x), (y - r.y) * r.width + (box.x - r.x) + box.width);
    return out;
  }

  /**
   * What a knockout reveals over r: Shallow, the backdrop its group started from (transparency for an isolated
   * group; for a layer of the root, as Deep); Deep, the Background layer alone (transparency without one).
   */
  knockBackdrop(layer, knockout, r, doc, opts) {
    const parent = layer.parent;
    if (knockout === 'shallow' && parent && parent !== doc.root) {
      const snap = this.knockStack.get(parent);
      if (!snap) return null;
      const c = createCanvas(snap.rect.width, snap.rect.height);
      c.getContext('2d').putImageData(snap.data, 0, 0);
      return readRegion(c, snap.rect.x, snap.rect.y, r);
    }
    const bg = backgroundOf(doc);
    if (!bg || bg === layer) return null;
    const c = createCanvas(r.width, r.height);
    const g = c.getContext('2d', { willReadFrequently: true });
    g.translate(-r.x, -r.y);
    this.drawLayer(g, bg, [], r, doc, { ...opts, until: null });
    return g.getImageData(0, 0, r.width, r.height);
  }

  /** An adjustment layer clipped to a base outside the group (Blend Clipped Layers as Group off): cut to the base. */
  drawClippedAdjustment(ctx, layer, base, rect, doc) {
    const below = ctx.getImageData(0, 0, rect.width, rect.height);
    const img = { width: below.width, height: below.height, data: new Uint8ClampedArray(below.data) };
    applyAdjustment(img, layer.kind, layer.params, null, { origin: { x: rect.x, y: rect.y }, docWidth: doc?.width ?? rect.width, docHeight: doc?.height ?? rect.height, scale: 1 });
    // the base's shape as the mask of the lerp, with the layer's own mask on top
    const m = createCanvas(doc.width, doc.height);
    const mg = m.getContext('2d');
    mg.drawImage(base.canvas, base.x, base.y);
    const own = maskCanvasFor(layer, doc, { purpose: 'composite' }); // mask (K.1)
    if (own) {
      mg.globalCompositeOperation = 'destination-in';
      mg.drawImage(own, 0, 0);
    }
    this.mixAdjusted(ctx, layer, below, img, rect, m);
  }

  /** drawChildren, recording the backdrop the group starts from when a child knocks out to it (Shallow). */
  drawGroupChildren(ctx, group, rect, doc, opts) {
    if (!group.children.some((c) => c.visible && c.blending?.knockout === 'shallow')) return this.drawChildren(ctx, group, rect, doc, opts);
    this.knockStack.set(group, { data: ctx.getImageData(0, 0, rect.width, rect.height), rect });
    try {
      return this.drawChildren(ctx, group, rect, doc, opts);
    } finally {
      this.knockStack.delete(group);
    }
  }

  /**
   * A styled group's children over their whole content (effects reach across the repaint rect), cached on what they
   * depend on: their versions and visibility, the global light, the document size (K.3). A brush dab next to the
   * group touches neither, so its styles are not run again.
   */
  styledGroupSource(group, doc, opts) {
    const content = renderBounds(group);
    if (!content) return null;
    const pad = stylePadding(group.styles);
    const area = intersectRect(content, { x: -pad, y: -pad, width: doc.width + pad * 2, height: doc.height + pad * 2 });
    if (!area) return null;
    const angle = doc.globalLight?.angle ?? 120, altitude = doc.globalLight?.altitude ?? 30;
    const plain = !opts.skip && !opts.until && !opts.rawMode;
    const key = `${area.x},${area.y},${area.width},${area.height}|${angle},${altitude}|${doc.mode ?? ''}|${subtreeKey(group)}`;
    const cached = this.groupCache.get(group);
    if (plain && cached && cached.key === key) return cached;
    const tmp = createCanvas(area.width, area.height);
    const tctx = tmp.getContext('2d', { willReadFrequently: true });
    tctx.translate(-area.x, -area.y);
    const wasUnready = this.unready;
    this.unready = false;
    const stop = this.drawChildren(tctx, group, area, doc, opts);
    tctx.setTransform(1, 0, 0, 1, 0, 0);
    const entry = { key, canvas: tmp, x: area.x, y: area.y, stop };
    if (plain && !this.unready) this.groupCache.set(group, entry);
    this.unready = wasUnready || this.unready;
    return entry;
  }

  /** A clipped group's pixels: a styled one over its whole content (cached, K.3), else over the rect. */
  clippedGroupSource(group, rect, doc, opts) {
    return hasEnabledStyles(group.styles) ? this.styledGroupSource(group, doc, opts) : this.renderGroupCanvas(group, rect, doc, opts);
  }

  renderGroupCanvas(group, rect, doc, opts) {
    const tmp = createCanvas(rect.width, rect.height);
    const tctx = tmp.getContext('2d', { willReadFrequently: true });
    tctx.translate(-rect.x, -rect.y);
    this.drawChildren(tctx, group, rect, doc, opts);
    return { canvas: tmp, x: rect.x, y: rect.y };
  }

  /** The layer's own pixels (raster canvas or cached render) with its document offset. */
  layerSource(layer) {
    if (layer.type === 'raster') return { canvas: layer.canvas, x: layer.x, y: layer.y };
    if (typeof layer.render === 'function') {
      const r = layer.render();
      return r ? { canvas: r.canvas, x: r.x, y: r.y } : null;
    }
    return null;
  }

  /**
   * The layer's pixels with its effects (applyStyles), cached on the layer version, the source, the clipped layers,
   * the mask parts applied before, the global light and the blending options the styles read. `split` keeps the
   * exterior effects apart: the entry then also has `layer` (the content with its interior effects, at x, y, beside
   * the merged `canvas`), `layerBox` (where it has alpha, document coordinates, or null) and `parts`, the exterior
   * effects bottom first as { canvas, x, y, blend, opacity } in document coordinates (drawStack, drawPixels).
   */
  styledCanvas(layer, canvas, x, y, doc = null, { masked = false, clipKey = '', maskKey = '', interiorAsGroup = false, transparencyShapes = true, split = false } = {}) {
    const cached = this.styleCache.get(layer);
    const angle = doc?.globalLight?.angle ?? 120, altitude = doc?.globalLight?.altitude ?? 30;
    const optKey = `${interiorAsGroup ? 1 : 0}${transparencyShapes ? 1 : 0}${split ? 1 : 0}`;
    // a masked or clipped source is a fresh canvas every time: mask edits touch the layer and the clipped layers'
    // versions are in clipKey, so the versions are the key then
    const derived = (masked && cached?.masked) || clipKey !== '';
    const sameSource = cached && (cached.source === canvas || (derived && cached.w === canvas.width && cached.h === canvas.height)) && cached.x0 === x && cached.y0 === y;
    if (cached && cached.version === layer.version && sameSource && cached.clipKey === clipKey && cached.maskKey === maskKey && cached.angle === angle && cached.altitude === altitude && cached.optKey === optKey) return cached;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    // stored styles -> what applyStyles takes (pattern references decoded): lib/style-prepare.js (K.2)
    const { styles, ready } = prepareStyles(layer, doc);
    this.styleRuns++;
    // origin: where img's (0, 0) is in the document (patterns linked to the document, gradients aligned to it; a
    // group has no position of its own)
    const out = applyStyles(img, styles, {
      fillOpacity: layer.fillOpacity ?? 1, globalAngle: angle, globalAltitude: altitude, interiorAsGroup, transparencyShapes, split,
      origin: [x, y], docWidth: doc?.width, docHeight: doc?.height,
    });
    const toCanvas = (im) => {
      const c = createCanvas(im.width, im.height);
      c.getContext('2d').putImageData(new ImageData(im.data, im.width, im.height), 0, 0);
      return c;
    };
    const result = toCanvas(out.image);
    const ox = x + out.offsetX, oy = y + out.offsetY;
    let content = null, parts = null, layerBox = null;
    if (split) {
      content = toCanvas(out.layer);
      parts = out.parts.map((p) => ({ canvas: toCanvas(p.image), x: ox + p.x, y: oy + p.y, blend: p.blend, opacity: p.opacity }));
      const b = alphaBox(out.layer);
      layerBox = b ? { x: ox + b.x, y: oy + b.y, width: b.width, height: b.height } : { x: ox, y: oy, width: 0, height: 0 };
    }
    // renders that are never drawn into again: drawPixels may measure where they have alpha once (frozenBounds)
    if (ready) {
      const frozen = this.frozen ?? (this.frozen = new WeakMap());
      frozen.set(result, false);
      if (content) frozen.set(content, layerBox.width ? { x: layerBox.x - ox, y: layerBox.y - oy, width: layerBox.width, height: layerBox.height } : null);
    }
    const entry = { version: layer.version, source: canvas, masked, clipKey, maskKey, optKey, x0: x, y0: y, w: canvas.width, h: canvas.height, canvas: result, layer: content, layerBox, parts, x: ox, y: oy, angle, altitude };
    // a pattern still decoding must not be cached as "no pattern"
    if (ready) this.styleCache.set(layer, entry);
    else this.unready = true;
    return entry;
  }

  /** Applies an adjustment layer to what is already drawn in ctx within rect, through its mask and opacity. */
  drawAdjustment(ctx, layer, rect, doc) {
    const below = ctx.getImageData(0, 0, rect.width, rect.height); // getImageData ignores the transform; the target canvas is rect-sized
    this.adjustInto(below, layer, rect, doc);
    putAt(ctx, below);
  }

  /**
   * Consecutive adjustment layers in one pass over the pixels (REPAINT.chain): one getImageData and one putImageData
   * for all of them. Between two layers the unchained passes wrote the canvas and read it back, which rounds
   * translucent pixels through premultiplied alpha; `roundtrip` does the same to the data, so the pixels match.
   */
  drawAdjustmentChain(ctx, layers, rect, doc) {
    this.chainRuns = (this.chainRuns ?? 0) + 1;
    const below = ctx.getImageData(0, 0, rect.width, rect.height);
    for (let k = 0; k < layers.length; k++) {
      if (k) roundtrip(below.data);
      this.adjustInto(below, layers[k], rect, doc);
    }
    putAt(ctx, below);
  }

  /** One adjustment layer on `below` (ImageData of rect), in place: adjusted on a copy, then mixed back. */
  adjustInto(below, layer, r, doc) {
    const img = { width: below.width, height: below.height, data: new Uint8ClampedArray(below.data) };
    // ctx (I.4): where the target's (0, 0) is in the document (a clipped adjustment: its base layer's sub-rect)
    applyAdjustment(img, layer.kind, layer.params, null, { origin: { x: r.x, y: r.y }, docWidth: doc?.width ?? r.width, docHeight: doc?.height ?? r.height, scale: 1 });
    // the adjusted pixels replace the originals (a lerp by opacity × mask): drawing them over would re-composite
    // partially transparent pixels onto themselves and change their alpha
    let mask = maskCanvasFor(layer, doc, { purpose: 'composite' }); // mask (K.1)
    // an all-white mask (a new adjustment layer's) weighs every pixel by 1: reading it changes nothing
    if (mask && REPAINT.chain && this.whiteOver(mask, layer, r)) mask = null;
    this.mixAdjustedData(layer, below, img, r, mask);
  }

  /**
   * True when `mask` (a document-aligned mask canvas of `layer`) is opaque white over all of r. Measured once per
   * mask canvas and layer version (painting on the mask touches the layer).
   */
  whiteOver(mask, layer, r) {
    if (r.x < 0 || r.y < 0 || r.x + r.width > mask.width || r.y + r.height > mask.height) return false;
    const cache = this.white ?? (this.white = new WeakMap()); // mask canvas -> { layer, version, w, h, white }
    const hit = cache.get(mask);
    if (hit && hit.layer === layer && hit.version === layer.version && hit.w === mask.width && hit.h === mask.height) return hit.white;
    const d = mask.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, mask.width, mask.height).data;
    let white = true;
    for (let p = 3; p < d.length; p += 4) {
      if (d[p] !== 255) {
        white = false;
        break;
      }
    }
    cache.set(mask, { layer, version: layer.version, w: mask.width, h: mask.height, white });
    return white;
  }

  /**
   * Puts an adjustment layer's result into ctx (rect-sized, holding `below`): 0.3's lerp by opacity × mask when the
   * layer has no Blending Options that change the mix, else blend-if.js mixAdjustment, as Photoshop composites an
   * adjustment layer: the adjusted pixels in the layer's mode, by opacity × fill × mask × Blend If (This Layer reads
   * the adjusted pixels, Underlying Layer the backdrop), with the channels switched off keeping the backdrop.
   * `maskCanvas` is document-sized (the layer's mask, and a clipping base's shape), or null.
   */
  mixAdjusted(ctx, layer, below, adjusted, r, maskCanvas) {
    this.mixAdjustedData(layer, below, adjusted, r, maskCanvas);
    putAt(ctx, below);
  }

  /** mixAdjusted without the put: `below` (ImageData of r) takes the result. */
  mixAdjustedData(layer, below, adjusted, r, maskCanvas) {
    const mix = adjustmentMix(layer, layer.blending);
    if (!mix) return this.lerpData(below, adjusted.data, r, layer.opacity, maskCanvas);
    let coverage = null;
    if (maskCanvas) {
      const mc = createCanvas(r.width, r.height);
      mc.getContext('2d').drawImage(maskCanvas, -r.x, -r.y);
      const m = mc.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, r.width, r.height).data;
      coverage = new Uint8ClampedArray(r.width * r.height);
      for (let i = 0, p = 3; i < coverage.length; i++, p += 4) coverage[i] = m[p];
    }
    mixAdjustment(below, adjusted, { ...mix, coverage, x: r.x, y: r.y });
  }

  /** Replaces what ctx holds within rect by a lerp towards `after` (a rect-sized canvas) by opacity × mask. */
  lerpInto(ctx, after, rect, opacity, maskCanvas) {
    const below = ctx.getImageData(0, 0, rect.width, rect.height);
    const a = after.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, rect.width, rect.height).data;
    this.lerpPixels(ctx, below, a, rect, opacity, maskCanvas);
  }

  lerpPixels(ctx, below, a, r, opacity, maskCanvas) {
    this.lerpData(below, a, r, opacity, maskCanvas);
    putAt(ctx, below);
  }

  /** lerpPixels without the put: `below` takes the lerp towards `a` by opacity × mask. */
  lerpData(below, a, r, opacity, maskCanvas) {
    let m = null;
    if (maskCanvas) {
      const mc = createCanvas(r.width, r.height);
      mc.getContext('2d').drawImage(maskCanvas, -r.x, -r.y);
      m = mc.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, r.width, r.height).data;
    }
    const o = Math.max(0, Math.min(1, opacity ?? 1));
    const d = below.data;
    for (let i = 0; i < d.length; i += 4) {
      const t = o * (m ? m[i + 3] / 255 : 1);
      if (t <= 0) continue;
      if (t >= 1) {
        d[i] = a[i];
        d[i + 1] = a[i + 1];
        d[i + 2] = a[i + 2];
        d[i + 3] = a[i + 3];
      } else if (d[i + 3] === a[i + 3]) {
        d[i] += (a[i] - d[i]) * t;
        d[i + 1] += (a[i + 1] - d[i + 1]) * t;
        d[i + 2] += (a[i + 2] - d[i + 2]) * t;
      } else {
        // ImageData is straight alpha: interpolate premultiplied so a transparent side contributes no colour
        const a0 = d[i + 3] / 255, a1 = a[i + 3] / 255;
        const w0 = a0 * (1 - t), w1 = a1 * t;
        const an = w0 + w1;
        if (an <= 0) {
          d[i] = d[i + 1] = d[i + 2] = d[i + 3] = 0;
          continue;
        }
        d[i] = (d[i] * w0 + a[i] * w1) / an;
        d[i + 1] = (d[i + 1] * w0 + a[i + 1] * w1) / an;
        d[i + 2] = (d[i + 2] * w0 + a[i + 2] * w1) / an;
        d[i + 3] = an * 255;
      }
    }
  }

  invalidate() {
    this.full = null;
    this.records = null;
    this.snaps = [];
    this.hints.clear();
  }
}

/** Writes ImageData at the target's (0, 0), whatever ctx's transform. */
function putAt(ctx, img) {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.putImageData(img, 0, 0);
  ctx.restore();
}

/** Whether ctx draws into a canvas kept in memory (willReadFrequently): the one roundtripTable is measured on. */
function softCanvas(ctx) {
  try {
    return ctx.getContextAttributes?.().willReadFrequently === true;
  } catch {
    return false;
  }
}

/**
 * Appends a layer's keys (repaint-plan.js pkey and vkey) to k, and the layer with its descendants to k.layers. What
 * the compositor reads straight from a layer is in pkey by value or by object identity (edits replace these objects;
 * in-place edits touch the layer, which moves vkey); a rendered layer adds its cached render's canvas, which is new
 * whenever its source or settings change (a smart object's source document, a fill's document size).
 */
function keyOf(l, k, shown, comp, state) {
  k.layers.push(l);
  k.v += `${l.version},`;
  k.p += `${oid(l)}:${l.visible ? 1 : 0}${l.clip ? 1 : 0}:${l.opacity}:${l.fillOpacity}:${l.blend}:${oid(l.blending)}:${oid(l.styles)}:${maskCacheKey(l)}`;
  if (shown && l.blend === 'dissolve') state.regionOk = false; // its noise follows the repaint rect (drawBlended)
  if (l.type === 'raster') k.p += `:${oid(l.canvas)}:${l.canvas.width}x${l.canvas.height}@${l.x},${l.y}`;
  else if (l.type === 'adjustment') {
    k.p += `:${l.kind}:${oid(l.params)}`;
    if (shown && !isLocalAdjustment(l)) state.regionOk = false;
  } else if (l.isGroup) {
    k.p += '[';
    for (const c of l.children) keyOf(c, k, shown && c.visible, comp, state);
    k.p += ']';
  } else if (shown) {
    const src = comp.layerSource(l);
    k.p += src ? `:${oid(src.canvas)}@${src.x},${src.y}` : ':-';
  }
  k.p += ';';
}

/** The index of the unit that holds `layer` (the root child it sits in), or 0. */
function unitOf(plan, layer) {
  let top = layer;
  while (top?.parent && top.parent.parent) top = top.parent;
  const kids = top?.parent?.children;
  const i = kids ? kids.indexOf(top) : -1;
  if (i < 0) return 0;
  let u = 0;
  for (let n = 0; n < plan.units.length; n++) if (plan.units[n].start <= i) u = n;
  return u;
}

/** True when every unit that changed between two plans draws inside r, as drawn (compositeView's region check). */
function insideRegion(prev, next, r) {
  const inside = (b) => !b || (b !== ALL && b.x >= r.x && b.y >= r.y && b.x + b.width <= r.x + r.width && b.y + b.height <= r.y + r.height);
  for (let i = 0; i < next.units.length; i++) {
    const u = prev.units[i], v = next.units[i];
    if (!u || u.id !== v.id) return false;
    if (u.pkey === v.pkey && u.vkey === v.vkey) continue;
    if (u.pkey === v.pkey && v.hint) continue;
    if (!inside(u.box) || !inside(v.box)) return false;
  }
  return true;
}

/** The px a partial composite grows by: the margins (I.4) of the visible adjustment layers whose kind declares one. */
function adjustmentMargin(doc) {
  let m = 0;
  const walk = (group) => {
    for (const l of group.children) {
      if (!l.visible) continue;
      if (l.isGroup) walk(l);
      else if (l.type === 'adjustment') {
        const def = adjustmentDef(l.kind);
        if (typeof def?.margin === 'function') m += Math.max(0, Math.ceil(Number(def.margin(l.params ?? {})) || 0));
      }
    }
  };
  walk(doc.root);
  return m;
}

/** Flattens a document to a new canvas (what export uses). */
export function flattenDocument(doc, compositor = new Compositor()) {
  const c = compositor.composite(doc);
  const out = createCanvas(doc.width, doc.height);
  out.getContext('2d').drawImage(c, 0, 0);
  return out;
}

/**
 * The flattened document as its layers store it: without the image mode's display pass (duotone inks, the spot
 * channels left of a multichannel image). Whatever is read to become pixels of the same document again (a merged
 * copy pasted back, Select and Mask's new layer, a clone source, the eyedropper's colour) must come from here: the
 * mode shows stored pixels through its renderer, so displayed pixels written back would be mapped a second time.
 */
export function flattenStored(doc, compositor = new Compositor()) {
  if (!doc.mode || doc.mode === 'rgb' || !MODE_RENDERERS.has(doc.mode)) return flattenDocument(doc, compositor);
  return compositor.composite(doc, { rawMode: true }); // never cached: a canvas of its own
}

export { unionRect };
