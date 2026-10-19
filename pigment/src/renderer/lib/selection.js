// Selection: a document-sized coverage mask with cached outline (marching ants) and alpha canvas.
import * as ops from '../../shared/pixels/selection-ops.js';
import { createCanvas } from './document.js';

export class Selection {
  /**
   * @param {number} width
   * @param {number} height
   * @param {Uint8ClampedArray} [mask]
   */
  constructor(width, height, mask = null) {
    this.width = width;
    this.height = height;
    this.mask = mask ?? new Uint8ClampedArray(width * height);
    this._bounds = undefined;
    this._outline = null;
    this._canvas = null;
    this.version = 0;
  }

  static fromRect(width, height, rect, { antialias = false } = {}) {
    const s = new Selection(width, height);
    const x1 = Math.max(0, Math.round(rect.x)), y1 = Math.max(0, Math.round(rect.y));
    const x2 = Math.min(width, Math.round(rect.x + rect.width)), y2 = Math.min(height, Math.round(rect.y + rect.height));
    for (let y = y1; y < y2; y++) s.mask.fill(255, y * width + x1, y * width + x2);
    void antialias;
    return s;
  }

  static fromEllipse(width, height, rect, { antialias = true } = {}) {
    return new Selection(width, height, ops.rasterizeEllipse(rect, width, height, { antialias }));
  }

  static fromPolygon(width, height, points, { antialias = true } = {}) {
    return new Selection(width, height, ops.rasterizePolygon(points, width, height, { antialias }));
  }

  static fromMask(width, height, mask) {
    return new Selection(width, height, mask);
  }

  static all(width, height) {
    const s = new Selection(width, height);
    s.mask.fill(255);
    return s;
  }

  get isEmpty() {
    return this.bounds === null;
  }

  /** Bounds of non-zero coverage (null when empty). */
  get bounds() {
    if (this._bounds === undefined) this._bounds = ops.maskBounds(this.mask, this.width, this.height);
    return this._bounds;
  }

  /** True when every pixel inside bounds is fully selected (a plain rectangle). */
  get isRect() {
    const b = this.bounds;
    if (!b) return false;
    for (let y = b.y; y < b.y + b.height; y++) {
      const row = y * this.width;
      for (let x = b.x; x < b.x + b.width; x++) if (this.mask[row + x] !== 255) return false;
    }
    return true;
  }

  invalidate() {
    this._bounds = undefined;
    this._outline = null;
    this._canvas = null;
    this.version++;
  }

  clone() {
    return new Selection(this.width, this.height, new Uint8ClampedArray(this.mask));
  }

  /** Combines with another selection (same size) and returns a new one. */
  combine(other, mode = 'replace') {
    if (mode === 'replace' || !other) return other ? other.clone() : this.clone();
    return new Selection(this.width, this.height, ops.combineMasks(this.mask, other.mask, mode));
  }

  invert() {
    return new Selection(this.width, this.height, ops.invertMask(this.mask));
  }

  feather(radius) {
    const s = this.clone();
    ops.feather(s.mask, s.width, s.height, radius);
    s.invalidate();
    return s;
  }
  expand(px) {
    const s = this.clone();
    s.mask = ops.expand(s.mask, s.width, s.height, px) ?? s.mask;
    s.invalidate();
    return s;
  }
  contract(px) {
    const s = this.clone();
    s.mask = ops.contract(s.mask, s.width, s.height, px) ?? s.mask;
    s.invalidate();
    return s;
  }
  border(px) {
    const s = this.clone();
    s.mask = ops.border(s.mask, s.width, s.height, px) ?? s.mask;
    s.invalidate();
    return s;
  }
  smooth(radius) {
    const s = this.clone();
    s.mask = ops.smooth(s.mask, s.width, s.height, radius) ?? s.mask;
    s.invalidate();
    return s;
  }

  /** Closed polygons (pixel-corner coordinates) tracing the selected area, cached. */
  outline() {
    if (!this._outline) this._outline = ops.outline(this.mask, this.width, this.height, 128);
    return this._outline;
  }

  /** Path2D of the outline in document coordinates. */
  path2d() {
    const p = new Path2D();
    for (const poly of this.outline()) {
      if (!poly.length) continue;
      p.moveTo(poly[0][0], poly[0][1]);
      for (let i = 1; i < poly.length; i++) p.lineTo(poly[i][0], poly[i][1]);
      p.closePath();
    }
    return p;
  }

  /** Alpha canvas (white with alpha = coverage) for destination-in clipping, cached. */
  toCanvas() {
    if (this._canvas) return this._canvas;
    const c = createCanvas(this.width, this.height);
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(this.width, this.height);
    const d = img.data;
    const m = this.mask;
    for (let i = 0, j = 0; i < m.length; i++, j += 4) {
      d[j] = d[j + 1] = d[j + 2] = 255;
      d[j + 3] = m[i];
    }
    ctx.putImageData(img, 0, 0);
    this._canvas = c;
    return c;
  }

  /** Coverage (0..1) at a pixel. */
  at(x, y) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return 0;
    return this.mask[Math.floor(y) * this.width + Math.floor(x)] / 255;
  }

  /** Applies the selection as a clip to a canvas region: pixels outside become transparent (in place). */
  clipCanvas(canvas, offsetX = 0, offsetY = 0) {
    const ctx = canvas.getContext('2d');
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'destination-in';
    ctx.drawImage(this.toCanvas(), -offsetX, -offsetY);
    ctx.restore();
  }

  /** Transforms the mask with an affine matrix (document coordinates), returning a new selection. */
  transformed(matrix, transformModule) {
    const img = { width: this.width, height: this.height, data: new Uint8ClampedArray(this.width * this.height * 4) };
    for (let i = 0, j = 3; i < this.mask.length; i++, j += 4) img.data[j] = this.mask[i];
    const out = transformModule.resample(img, matrix, { x: 0, y: 0, width: this.width, height: this.height }, { quality: 'bilinear' });
    const mask = new Uint8ClampedArray(this.width * this.height);
    for (let i = 0, j = 3; i < mask.length; i++, j += 4) mask[i] = out.data[j];
    return new Selection(this.width, this.height, mask);
  }

  /** Resizes the mask canvas (when the document canvas changes), keeping the selection in place with an offset. */
  resized(width, height, dx = 0, dy = 0) {
    const s = new Selection(width, height);
    for (let y = 0; y < this.height; y++) {
      const ny = y + dy;
      if (ny < 0 || ny >= height) continue;
      for (let x = 0; x < this.width; x++) {
        const nx = x + dx;
        if (nx < 0 || nx >= width) continue;
        s.mask[ny * width + nx] = this.mask[y * this.width + x];
      }
    }
    return s;
  }
}

export { ops as selectionOps };
