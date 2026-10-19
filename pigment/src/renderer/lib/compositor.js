// Renders a document's layer tree to a canvas (see ARCHITECTURE.md "Compositor"). Canvas 2D does
// most blending on the GPU; blend modes it lacks fall back to src/shared/pixels/blend.js on the
// affected rectangle. Everything is cached per layer version so repainting during a brush stroke
// only touches the dirty rectangle.
import { createCanvas, intersectRect, unionRect } from './document.js';
import { CANVAS_BLEND, blendImages } from '../../shared/pixels/blend.js';
import { applyAdjustment } from '../../shared/pixels/adjust.js';
import { applyStyles, stylePadding } from '../../shared/pixels/styles.js';
import { resolvePattern } from './patterns.js';

const SIMPLE_OVER = new Set(['normal', 'pass-through']);

export class Compositor {
  constructor() {
    this.styleCache = new WeakMap(); // layer -> { version, canvas, x, y }
    this.adjustCache = new WeakMap(); // layer -> { key, canvas }
    this.full = null; // { version, canvas } for the whole document
  }

  /**
   * Composites `doc` (or just `rect` of it) and returns a canvas of rect size whose (0,0) is rect.x/y.
   * @param {import('./document.js').Document} doc
   * @param {{ rect?: object, skip?: Set<object>, until?: object, hideSelection?: boolean, target?: HTMLCanvasElement }} opts
   */
  composite(doc, opts = {}) {
    const rect = opts.rect ? intersectRect(opts.rect, doc.bounds) ?? { x: 0, y: 0, width: 1, height: 1 } : doc.bounds;
    const isFull = !opts.rect && !opts.skip && !opts.until && !opts.target;
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
      // only Pass Through lets the children blend with what is below the group; Normal isolates them
      const passThrough = layer.blend === 'pass-through' && layer.opacity >= 1 && !layer.mask?.enabled && !clipped.length && !layer.styles;
      if (passThrough) return this.drawChildren(ctx, layer, rect, doc, opts);
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

  /** Applies clipping layers, styles, mask, opacity and blend mode, then draws into ctx. */
  finishLayer(ctx, layer, canvas, x, y, clipped, rect, doc, opts) {
    let work = canvas, wx = x, wy = y;
    if (clipped.length) {
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
        const cs = c.isGroup ? this.renderGroupCanvas(c, sub, doc, opts) : this.layerSource(c);
        if (!cs) continue;
        this.finishLayer(cctx, c, cs.canvas, cs.x, cs.y, [], sub, doc, opts);
      }
      cctx.setTransform(1, 0, 0, 1, 0, 0);
      // keep only where the base had alpha
      cctx.globalCompositeOperation = 'destination-in';
      cctx.drawImage(canvas, 0, 0);
      work = copy;
    }
    const styled = !!layer.styles && Object.values(layer.styles).some((s) => s?.enabled);
    if (layer.fillOpacity < 1 && !layer.isGroup && !styled) {
      const faded = createCanvas(work.width, work.height);
      const fctx = faded.getContext('2d');
      fctx.globalAlpha = layer.fillOpacity;
      fctx.drawImage(work, 0, 0);
      work = faded;
    }
    // the mask shapes the layer before its effects (Photoshop's default: a stroke or shadow follows the mask edge)
    const masked = !!(layer.mask?.enabled && layer.mask.canvas);
    if (masked) {
      const m = createCanvas(work.width, work.height);
      const mctx = m.getContext('2d');
      mctx.drawImage(work, 0, 0);
      mctx.globalCompositeOperation = 'destination-in';
      mctx.drawImage(layer.mask.canvas, -wx, -wy);
      work = m;
    }
    if (styled) {
      const out = this.styledCanvas(layer, work, wx, wy, doc, { masked });
      if (out) {
        work = out.canvas;
        wx = out.x;
        wy = out.y;
      }
    }
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

  styledCanvas(layer, canvas, x, y, doc = null, { masked = false } = {}) {
    const cached = this.styleCache.get(layer);
    const angle = doc?.globalLight?.angle ?? 120, altitude = doc?.globalLight?.altitude ?? 30;
    // a masked source is a fresh canvas every time: mask edits touch the layer, so its version is the key then
    const sameSource = cached && (cached.source === canvas || (masked && cached.masked && cached.x0 === x && cached.y0 === y && cached.w === canvas.width && cached.h === canvas.height));
    if (cached && cached.version === layer.version && sameSource && cached.angle === angle && cached.altitude === altitude) return cached;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let styles = layer.styles;
    const po = styles.patternOverlay;
    if (po?.enabled && typeof po.pattern === 'string') {
      const data = resolvePattern(po.pattern, () => {
        layer.touch();
        doc?.changed('pixels', { layer });
      });
      styles = { ...styles, patternOverlay: { ...po, pattern: data, enabled: !!data } };
    }
    const out = applyStyles(img, styles, { fillOpacity: layer.fillOpacity ?? 1, globalAngle: angle, globalAltitude: altitude });
    const result = createCanvas(out.image.width, out.image.height);
    result.getContext('2d').putImageData(new ImageData(out.image.data, out.image.width, out.image.height), 0, 0);
    const entry = { version: layer.version, source: canvas, masked, x0: x, y0: y, w: canvas.width, h: canvas.height, canvas: result, x: x + out.offsetX, y: y + out.offsetY, angle, altitude };
    // a pattern still decoding must not be cached as "no pattern"
    if (!(styles.patternOverlay?.enabled === false && layer.styles.patternOverlay?.enabled)) this.styleCache.set(layer, entry);
    return entry;
  }

  /** Applies an adjustment layer to what is already drawn in ctx within rect, through its mask and opacity. */
  drawAdjustment(ctx, layer, rect, doc) {
    const r = rect;
    const below = ctx.getImageData(0, 0, r.width, r.height); // getImageData ignores the transform; the target canvas is rect-sized
    const img = { width: below.width, height: below.height, data: new Uint8ClampedArray(below.data) };
    applyAdjustment(img, layer.kind, layer.params);
    // the adjusted pixels replace the originals (a lerp by opacity × mask): drawing them over would re-composite
    // partially transparent pixels onto themselves and change their alpha
    let m = null;
    if (layer.mask?.enabled && layer.mask.canvas) {
      const mc = createCanvas(r.width, r.height);
      mc.getContext('2d').drawImage(layer.mask.canvas, -r.x, -r.y);
      m = mc.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, r.width, r.height).data;
    }
    const o = Math.max(0, Math.min(1, layer.opacity ?? 1));
    const d = below.data, a = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const t = o * (m ? m[i + 3] / 255 : 1);
      if (t <= 0) continue;
      if (t >= 1) {
        d[i] = a[i];
        d[i + 1] = a[i + 1];
        d[i + 2] = a[i + 2];
        d[i + 3] = a[i + 3];
      } else {
        d[i] += (a[i] - d[i]) * t;
        d[i + 1] += (a[i + 1] - d[i + 1]) * t;
        d[i + 2] += (a[i + 2] - d[i + 2]) * t;
        d[i + 3] += (a[i + 3] - d[i + 3]) * t;
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

/** Flattens a document to a new canvas (what export uses). */
export function flattenDocument(doc, compositor = new Compositor()) {
  const c = compositor.composite(doc);
  const out = createCanvas(doc.width, doc.height);
  out.getContext('2d').drawImage(c, 0, 0);
  return out;
}

export { unionRect };
