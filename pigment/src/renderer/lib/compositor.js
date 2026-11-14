// Renders a document's layer tree to a canvas (see ARCHITECTURE.md "Compositor"). Canvas 2D does
// most blending on the GPU; blend modes it lacks fall back to src/shared/pixels/blend.js on the
// affected rectangle. Everything is cached per layer version so repainting during a brush stroke
// only touches the dirty rectangle.
import { createCanvas, intersectRect, unionRect, effectiveBlending, isDefaultBlending } from './document.js';
import { CANVAS_BLEND, blendImages } from '../../shared/pixels/blend.js';
import { compositeAdvanced, maskPartsAround, restrictsChannels, isDefaultBlendIf, alphaBox } from '../../shared/pixels/blend-if.js';
import { applyAdjustment, adjustmentDef } from '../../shared/pixels/adjust.js';
import { applyStyles, stylePadding, hasEnabledStyles } from '../../shared/pixels/styles.js';
import { maskCanvasFor, applyLayerMask, hasEffectiveMask, maskCacheKey } from './mask-render.js';
import { prepareStyles } from './style-prepare.js';

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
  constructor() {
    this.styleCache = new WeakMap(); // layer -> { version, canvas, x, y }
    this.adjustCache = new WeakMap(); // layer -> { key, canvas }
    this.full = null; // { version, canvas } for the whole document
    this.groupCache = new WeakMap(); // styled group -> { key, canvas, x, y } of its children (K.3)
    this.styleRuns = 0; // applyStyles calls (tests check that a repaint next to a styled group runs none)
    this.knockStack = new Map(); // pass-through group -> { data, rect }: the backdrop its shallow knockouts reveal
    this.unready = false; // set while a styled render waits for a pattern (not cached)
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

  /** Renders the group's children into ctx (ctx already translated so document coordinates apply). */
  drawChildren(ctx, group, rect, doc, opts) {
    const kids = group.children;
    for (let i = 0; i < kids.length; i++) {
      const layer = kids[i];
      if (opts.until && layer === opts.until) return true;
      if (!layer.visible || opts.skip?.has(layer)) continue;
      // a clipped layer is drawn with its base below; without any base (it sits at the bottom) it is an ordinary layer
      if (layer.clip && kids.slice(0, i).some((k) => !k.clip)) continue;
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
    if (clipped.length) work = this.clipGroup(work, wx, wy, clipped, doc, opts);
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
      const out = this.styledCanvas(layer, work, wx, wy, doc, { masked, clipKey, maskKey: maskCacheKey(layer) }); // mask (K.1)
      if (out) {
        work = out.canvas;
        wx = out.x;
        wy = out.y;
      }
    }
    if (clipTo) work = clipToAlpha(work, wx, wy, clipTo);
    this.drawWork(ctx, layer, work, wx, wy, rect);
  }

  /** Draws a finished layer image with the layer's blend mode and opacity (Canvas when it can, else per pixel). */
  drawWork(ctx, layer, work, wx, wy, rect) {
    const mode = layer.isGroup && layer.blend === 'pass-through' ? 'normal' : layer.blend;
    const op = CANVAS_BLEND[mode] ?? (SIMPLE_OVER.has(mode) ? 'source-over' : null);
    if (op) {
      ctx.save();
      ctx.globalAlpha = layer.opacity;
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
    blendImages(mode, src, dst, layer.opacity);
    ctx.putImageData(dst, overlap.x - rect.x, overlap.y - rect.y);
  }

  /** The base composited with its clipped layers (Blend Clipped Layers as Group, 0.3's clipping), cut to its alpha. */
  clipGroup(work, wx, wy, clipped, doc, opts) {
    // composite clipped layers onto a copy limited to the base alpha
    const copy = createCanvas(work.width, work.height);
    const cctx = copy.getContext('2d', { willReadFrequently: true });
    cctx.drawImage(work, 0, 0);
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
   * K.3: a layer whose blending options are not the defaults. Clipped layers (as a group, or each over the backdrop
   * cut to the base's shape), the mask parts before the effects, fill opacity, the effects with Blend Interior Effects
   * as Group and Transparency Shapes Layer, the mask parts after them; then knockout, Blend If and the channels per
   * pixel (blend-if.js compositeAdvanced) when one of them is set, else the ordinary draw.
   */
  finishAdvanced(ctx, layer, canvas, x, y, clipped, rect, doc, opts, bl, clipTo) {
    let work = canvas, wx = x, wy = y;
    const grouped = bl.clippedAsGroup !== false;
    if (clipped.length && grouped) work = this.clipGroup(work, wx, wy, clipped, doc, opts);
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
    let below = null;
    if (styled) {
      const clipKey = clipped.length && grouped ? clipped.map((c) => `${c.id}:${c.version}`).join(',') : '';
      // Blend If leaves the exterior effects alone: the styles come split (styles.js split option)
      const out = this.styledCanvas(layer, work, wx, wy, doc, {
        masked: maskedBefore, clipKey, maskKey: parts.before ? maskCacheKey(layer, parts.before) : 'none', // mask (K.1)
        interiorAsGroup: !!bl.interiorAsGroup, transparencyShapes: bl.transparencyShapes !== false, split: blendIf,
      });
      if (out) {
        work = out.canvas;
        below = out.below ?? null;
        wx = out.x;
        wy = out.y;
      }
    }
    // the parts whose box is on hide the effects too: applied to everything the layer draws (K.1 parts of K.3)
    if (parts.after && hasEffectiveMask(layer, parts.after)) { // mask (K.1)
      work = applyLayerMask(work, wx, wy, layer, doc, { parts: parts.after }); // mask (K.1)
      if (below) below = applyLayerMask(below, wx, wy, layer, doc, { parts: parts.after }); // mask (K.1)
      shape = { canvas: applyLayerMask(shape.canvas, shape.x, shape.y, layer, doc, { parts: parts.after }), x: shape.x, y: shape.y }; // mask (K.1)
    }
    if (clipTo) {
      work = clipToAlpha(work, wx, wy, clipTo);
      if (below) below = clipToAlpha(below, wx, wy, clipTo);
      shape = { canvas: clipToAlpha(shape.canvas, shape.x, shape.y, clipTo), x: shape.x, y: shape.y };
    }
    const knockout = bl.knockout === 'shallow' || bl.knockout === 'deep' ? bl.knockout : 'none';
    if (knockout === 'none' && !blendIf && !restrictsChannels(bl.channels)) {
      if (below) this.drawWork(ctx, layer, below, wx, wy, rect);
      this.drawWork(ctx, layer, work, wx, wy, rect);
    } else {
      this.drawPixels(ctx, layer, { work, below, shape, wx, wy, knockout, bl }, rect, doc, opts);
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
  drawPixels(ctx, layer, { work, below, shape, wx, wy, knockout, bl }, rect, doc, opts) {
    let box = { x: wx, y: wy, width: work.width, height: work.height };
    if (knockout !== 'none') box = unionRect(box, { x: shape.x, y: shape.y, width: shape.canvas.width, height: shape.canvas.height });
    const r = intersectRect(box, rect);
    if (!r) return;
    const dst = ctx.getImageData(r.x - rect.x, r.y - rect.y, r.width, r.height);
    const layerImg = readRegion(work, wx, wy, r);
    const belowImg = below ? readRegion(below, wx, wy, r) : null;
    let shapeAlpha = null, knock = null;
    if (knockout !== 'none') {
      shapeAlpha = this.shapeAlpha(shape, r, bl.transparencyShapes !== false);
      knock = this.knockBackdrop(layer, knockout, r, doc, opts);
    }
    compositeAdvanced({
      dst, layer: layerImg, below: belowImg, knock, shape: shapeAlpha, knockout,
      blendIf: bl.blendIf, channels: bl.channels, mode: layer.isGroup && layer.blend === 'pass-through' ? 'normal' : layer.blend, opacity: layer.opacity,
    });
    ctx.putImageData(dst, r.x - rect.x, r.y - rect.y);
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
    this.lerpPixels(ctx, below, img.data, rect, layer.opacity, m);
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
   * the mask parts applied before, the global light and the blending options the styles read. `split` (Blend If)
   * keeps the exterior effects apart: the entry then has `below` beside `canvas`, both at x, y.
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
    const result = toCanvas(split ? out.layer : out.image);
    const below = split && out.below ? toCanvas(out.below) : null;
    const entry = { version: layer.version, source: canvas, masked, clipKey, maskKey, optKey, x0: x, y0: y, w: canvas.width, h: canvas.height, canvas: result, below, x: x + out.offsetX, y: y + out.offsetY, angle, altitude };
    // a pattern still decoding must not be cached as "no pattern"
    if (ready) this.styleCache.set(layer, entry);
    else this.unready = true;
    return entry;
  }

  /** Applies an adjustment layer to what is already drawn in ctx within rect, through its mask and opacity. */
  drawAdjustment(ctx, layer, rect, doc) {
    const r = rect;
    const below = ctx.getImageData(0, 0, r.width, r.height); // getImageData ignores the transform; the target canvas is rect-sized
    const img = { width: below.width, height: below.height, data: new Uint8ClampedArray(below.data) };
    // ctx (I.4): where the target's (0, 0) is in the document (a clipped adjustment: its base layer's sub-rect)
    applyAdjustment(img, layer.kind, layer.params, null, { origin: { x: r.x, y: r.y }, docWidth: doc?.width ?? r.width, docHeight: doc?.height ?? r.height, scale: 1 });
    // the adjusted pixels replace the originals (a lerp by opacity × mask): drawing them over would re-composite
    // partially transparent pixels onto themselves and change their alpha
    this.lerpPixels(ctx, below, img.data, r, layer.opacity, maskCanvasFor(layer, doc, { purpose: 'composite' })); // mask (K.1)
  }

  /** Replaces what ctx holds within rect by a lerp towards `after` (a rect-sized canvas) by opacity × mask. */
  lerpInto(ctx, after, rect, opacity, maskCanvas) {
    const below = ctx.getImageData(0, 0, rect.width, rect.height);
    const a = after.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, rect.width, rect.height).data;
    this.lerpPixels(ctx, below, a, rect, opacity, maskCanvas);
  }

  lerpPixels(ctx, below, a, r, opacity, maskCanvas) {
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
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.putImageData(below, 0, 0);
    ctx.restore();
  }

  invalidate() {
    this.full = null;
  }
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
