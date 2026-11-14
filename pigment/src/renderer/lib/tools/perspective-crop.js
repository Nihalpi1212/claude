// Perspective Crop tool (crop slot): mark the four corners of something photographed at an angle
// (drag a box and pull its corners, or click the corners one by one), press Enter, and the document
// is cropped to that quad straightened into a rectangle.
//
// The crop itself is the command `image:perspective-crop` { quad, width, height, resolution } so
// actions can replay it. Like the other whole-document operations it builds a new layer tree and
// swaps it in through structural(): undo restores the old tree exactly, old layers are never
// touched. A quad that is a parallelogram needs no perspective at all and goes through
// app.remapDocument (text, shapes and smart objects stay editable); a true perspective resamples
// every pixel layer and mask through the homography and rasterizes text and smart objects first
// (their glyphs and sources cannot carry a projective transform).
import { Tool } from '../tools.js';
import { createCanvas } from '../document.js';
import { structural, rasterizeLayer } from '../layer-ops.js';
import { bakeVectorMask } from '../image-ops.js';
import { mapShapeGeometry } from '../path-ops.js';
import * as T from '../../../shared/pixels/transform.js';
import { orderQuad, isConvexQuad, naturalSize, outputSize, isParallelogram, MAX_SIDE } from './perspective-quad.js';

export { orderQuad, isConvexQuad, naturalSize, outputSize };
const HANDLE = 9; // screen px a handle answers within
const clone = (v) => (v === undefined || v === null ? v : JSON.parse(JSON.stringify(v)));

// ---- pixels ---------------------------------------------------------------------------------------------------

const readCanvas = (c) => c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height);
function toCanvas(img) {
  const c = createCanvas(img.width, img.height);
  c.getContext('2d').putImageData(new ImageData(img.data instanceof Uint8ClampedArray ? img.data : new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
  return c;
}

/**
 * Warps a canvas placed at (ox, oy) in the old document into the new one. The quad maps onto an
 * inter.width × inter.height rectangle (the quad's natural size when the crop also shrinks, so the shrink is a
 * proper filtered resize and not a sparse sampling), which is then resized to W × H.
 * Returns { canvas, x, y } in new document coordinates, or null when nothing lands on the new canvas.
 */
function warpCanvas(canvas, ox, oy, quad, W, H, inter, quality) {
  const local = quad.map(([x, y]) => [x - ox, y - oy]);
  const dst = [[0, 0], [inter.width, 0], [inter.width, inter.height], [0, inter.height]];
  const direct = inter.width === W && inter.height === H;
  let rect = { x: 0, y: 0, width: inter.width, height: inter.height };
  if (direct) {
    // only the part of the new canvas this layer can reach is resampled (when its corners project cleanly)
    const Hf = T.homography(local, dst);
    const corners = [[0, 0], [canvas.width, 0], [canvas.width, canvas.height], [0, canvas.height]];
    if (corners.every(([x, y]) => Hf[6] * x + Hf[7] * y + Hf[8] > 1e-6)) {
      const pts = corners.map(([x, y]) => T.applyHomography(Hf, x, y));
      const x1 = Math.max(0, Math.floor(Math.min(...pts.map((p) => p[0])) - 1)), y1 = Math.max(0, Math.floor(Math.min(...pts.map((p) => p[1])) - 1));
      const x2 = Math.min(W, Math.ceil(Math.max(...pts.map((p) => p[0])) + 1)), y2 = Math.min(H, Math.ceil(Math.max(...pts.map((p) => p[1])) + 1));
      if (x2 <= x1 || y2 <= y1) return null;
      rect = { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
    }
  }
  let img = T.perspective(readCanvas(canvas), local, dst, rect, { quality });
  if (!direct) img = T.resize(img, W, H, { method: 'bicubic' });
  return { canvas: toCanvas(img), x: direct ? rect.x : 0, y: direct ? rect.y : 0 };
}

/** A document-sized mask canvas through the crop: outside the old canvas the mask continues with its background. */
function warpMask(mask, quad, W, H, inter, background = null) {
  let bg = background;
  if (bg === null) {
    try {
      bg = mask.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, 1, 1).data[3];
    } catch {
      bg = 255;
    }
  }
  let src = mask, ox = 0, oy = 0;
  const xs = quad.map((p) => p[0]), ys = quad.map((p) => p[1]);
  const x1 = Math.min(0, Math.floor(Math.min(...xs)) - 1), y1 = Math.min(0, Math.floor(Math.min(...ys)) - 1);
  const x2 = Math.max(mask.width, Math.ceil(Math.max(...xs)) + 1), y2 = Math.max(mask.height, Math.ceil(Math.max(...ys)) + 1);
  if (bg > 0 && (x1 < 0 || y1 < 0 || x2 > mask.width || y2 > mask.height) && (x2 - x1) * (y2 - y1) < 64e6) {
    // the quad reaches past the canvas: pad the mask with its background so the outside is not read as "hidden"
    src = createCanvas(x2 - x1, y2 - y1);
    const ctx = src.getContext('2d');
    ctx.fillStyle = `rgba(255,255,255,${bg / 255})`;
    ctx.fillRect(0, 0, src.width, src.height);
    ctx.clearRect(-x1, -y1, mask.width, mask.height);
    ctx.drawImage(mask, -x1, -y1);
    ox = x1;
    oy = y1;
  }
  const local = quad.map(([x, y]) => [x - ox, y - oy]);
  let img = T.perspective(readCanvas(src), local, [[0, 0], [inter.width, 0], [inter.width, inter.height], [0, inter.height]], { x: 0, y: 0, width: inter.width, height: inter.height }, { quality: 'bilinear' });
  if (inter.width !== W || inter.height !== H) img = T.resize(img, W, H, { method: 'bilinear' });
  return toCanvas(img);
}

function mapPath(path, f) {
  const out = clone(path);
  for (const sp of out?.subpaths ?? []) for (const pt of sp.points ?? []) {
    const inP = pt.inX !== undefined ? f(pt.inX, pt.inY) : null, outP = pt.outX !== undefined ? f(pt.outX, pt.outY) : null;
    [pt.x, pt.y] = f(pt.x, pt.y);
    if (inP) [pt.inX, pt.inY] = inP;
    if (outP) [pt.outX, pt.outY] = outP;
  }
  return out;
}

/** Copy of a layer object that is safe to change without touching the original (which undo puts back). */
function shallow(layer, over = {}) {
  const c = Object.assign(Object.create(Object.getPrototypeOf(layer)), layer);
  c.locked = { ...layer.locked };
  if (layer.mask) c.mask = { ...layer.mask };
  if ('_cache' in layer) c._cache = null;
  c.parent = null;
  Object.assign(c, over);
  c.version = (layer.version ?? 0) + 1;
  return c;
}

const nextFrame = () => new Promise((r) => setTimeout(r));
// The crop is written as a generator that yields between layers: a command run from the menu or an action lets the
// busy text paint at each yield, the tool's own commit runs it to the end in one go (see perspectiveCrop).
const drain = (it) => {
  let s;
  while (!(s = it.next()).done);
  return s.value;
};
const drive = async (it) => {
  let s;
  while (!(s = it.next()).done) await nextFrame();
  return s.value;
};

// ---- the crop ---------------------------------------------------------------------------------------------------

/**
 * Crops the active document to `quad` (four document points, any order) straightened to width × height.
 * resolution (pixels/inch) is optional. Resolves true when the document changed.
 *
 * sync: true does the whole crop before returning (true/false, no promise). The tool commits this way: everything
 * that calls tools.active.commit() as a step of its own work (saving, a filter, a History click, a rotate) goes on
 * with the document at once, so a crop that landed a few frames later would be missing from the saved file while
 * the document is marked saved, or would replace the layers a filter had just changed.
 */
export function perspectiveCrop(app, arg = {}, { sync = false } = {}) {
  const r = cropDocument(app, arg, sync);
  return sync ? r : Promise.resolve(r);
}

function cropDocument(app, { quad, width = 0, height = 0, resolution = 0 } = {}, sync = false) {
  const d = app.doc;
  if (!d || !Array.isArray(quad) || quad.length !== 4) return false;
  const q = orderQuad(quad);
  if (q.some((p) => !Number.isFinite(p[0]) || !Number.isFinite(p[1])) || !isConvexQuad(q)) {
    app.dialogs.toast('The four corners must form a convex shape: drag them so no corner points inwards', { kind: 'error', timeout: 3200 });
    return false;
  }
  const { width: W, height: H } = outputSize(q, width, height);
  const dpi = Number(resolution) > 0 ? Math.min(10000, Math.round(Number(resolution))) : 0;
  const dstRect = [[0, 0], [W, 0], [W, H], [0, H]];
  const Hf = T.homography(q, dstRect); // old document -> new document

  if (isParallelogram(q)) {
    // no perspective: an affine remap keeps type, shapes and smart objects editable
    const m = [Hf[0], Hf[3], Hf[1], Hf[4], Hf[2], Hf[5]];
    const exact = Math.abs(m[0] - 1) < 1e-9 && Math.abs(m[3] - 1) < 1e-9 && Math.abs(m[1]) < 1e-9 && Math.abs(m[2]) < 1e-9 && Number.isInteger(Math.round(m[4] * 1e6) / 1e6) && Number.isInteger(Math.round(m[5] * 1e6) / 1e6);
    const remap = () => {
      app.remapDocument('Perspective crop', exact
        ? { width: W, height: H, matrix: [1, 0, 0, 1, Math.round(m[4]), Math.round(m[5])], mode: 'translate', clip: true, keepSelection: false, dpi: dpi || undefined }
        : { width: W, height: H, matrix: m, mode: 'affine', clip: true, keepSelection: false, dpi: dpi || undefined });
      return true;
    };
    return sync ? remap() : app.busy('Cropping…', async () => remap());
  }

  const point = (x, y) => T.applyHomography(Hf, x, y);
  const natural = naturalSize(q);
  // shrinking by more than a quarter: warp at the quad's own size first, then resize with a proper filter
  const inter = W < natural.width * 0.75 || H < natural.height * 0.75 ? { width: Math.max(W, natural.width), height: Math.max(H, natural.height) } : { width: W, height: H };
  let rasterized = 0, bakedVector = 0;

  const mapLayer = function* (layer) {
    let out;
    if (layer.isGroup) {
      out = shallow(layer);
      out.children = [];
      for (const c of layer.children) {
        if (c.preview || c.quickMask) continue;
        const cc = yield* mapLayer(c);
        cc.parent = out;
        out.children.push(cc);
      }
    } else if (layer.type === 'raster' || (layer.type !== 'shape' && layer.type !== 'fill' && layer.type !== 'adjustment')) {
      let src = layer;
      if (layer.type !== 'raster') {
        // type, smart objects (and any layer kind added later): their pixels are warped, the layer becomes pixels
        src = rasterizeLayer(layer, d) ?? null;
        if (src) rasterized++;
      }
      yield;
      const r = src ? warpCanvas(src.canvas, src.x, src.y, q, W, H, inter, 'bicubic') : null;
      const props = { canvas: r?.canvas ?? createCanvas(1, 1), x: r?.x ?? 0, y: r?.y ?? 0, deep: null };
      if (layer.type === 'raster') out = shallow(layer, props);
      else {
        // the rasterized stand-in keeps the identity, locks, label and link of the layer it replaces
        out = Object.assign(src ?? shallow(layer), props, { id: layer.id, locked: { ...layer.locked }, parent: null });
        if (layer.color) out.color = layer.color;
        if (layer.linked) out.linked = layer.linked;
        out.mask = layer.mask ? { ...layer.mask } : null;
      }
    } else if (layer.type === 'shape') {
      // shapes keep their vectors through the homography (path-ops.js mapShapeGeometry, shapes-live, J.2)
      const g = mapShapeGeometry(layer, point, { homography: Hf });
      out = shallow(layer, { path: g.path, shapeKind: g.shapeKind, shapeProps: g.shapeProps, ...(g.fill ? { fill: g.fill } : {}), ...(g.stroke ? { stroke: g.stroke } : {}) });
    }
    else if (layer.type === 'fill') {
      const g = layer.paint?.gradient;
      out = shallow(layer, g?.from && g?.to ? { paint: { ...layer.paint, gradient: { ...g, from: point(...g.from), to: point(...g.to) } } } : {});
    } else out = shallow(layer);
    // a vector mask cannot stay a vector through a perspective: it is rendered into the raster mask, as type is
    let mask = layer.mask;
    if (layer.vectorMask) {
      mask = bakeVectorMask(layer, d);
      out.vectorMask = null;
      bakedVector++;
    }
    if (mask?.canvas) {
      yield;
      out.mask = { ...mask, canvas: warpMask(mask.canvas, q, W, H, inter) };
    }
    return out;
  };

  const alphaThroughCrop = (mask) => {
    const c = createCanvas(d.width, d.height);
    const img = new ImageData(d.width, d.height);
    for (let i = 0, j = 0; i < mask.length; i++, j += 4) {
      img.data[j] = img.data[j + 1] = img.data[j + 2] = 255;
      img.data[j + 3] = mask[i];
    }
    c.getContext('2d').putImageData(img, 0, 0);
    const data = readCanvas(warpMask(c, q, W, H, inter, 0)).data;
    const out = new Uint8ClampedArray(W * H);
    for (let i = 0, j = 3; i < out.length; i++, j += 4) out[i] = data[j];
    return out;
  };

  const work = function* () {
    // an open text edit must land in the tree before every layer is replaced
    const active = app.tools?.active;
    if (active?.session && typeof active.id === 'string' && active.id.startsWith('type-')) active.commit?.();
    const root = yield* mapLayer(d.root);
    root.parent = null;
    const channels = d.channels.map((ch) => ({ ...ch, mask: alphaThroughCrop(ch.mask) }));
    const paths = d.paths.map((p) => ({ ...p, path: mapPath(p.path, point) }));
    const workPath = d.workPath?.subpaths?.length ? mapPath(d.workPath, point) : d.workPath ?? null;
    const bytes = () => d.layers().reduce((n, l) => n + (l.canvas ? l.canvas.width * l.canvas.height * 4 : 0) + (l.mask?.canvas ? l.mask.canvas.width * l.mask.canvas.height * 4 : 0), 0);
    structural(app, 'Perspective crop', () => {
      // selections and guides belong to the old geometry (a straight guide does not stay axis-aligned)
      d.selection = null;
      d.savedSelection = null;
      d.guides = [];
      d.channels = channels;
      d.paths = paths;
      d.workPath = workPath;
      if (dpi) d.dpi = dpi;
      d.replaceTree(root, { width: W, height: H });
    }, d, { bytes });
  };
  const finish = () => {
    app.view?.center?.();
    app.view?.invalidate();
    if (rasterized) app.dialogs.toast(`${rasterized} type or smart object layer${rasterized === 1 ? ' was' : 's were'} rasterized: a perspective cannot stay editable`, { timeout: 3600 });
    if (bakedVector) app.dialogs.toast(`${bakedVector} vector mask${bakedVector === 1 ? ' was' : 's were'} rasterized into the layer mask: a perspective cannot stay a vector`, { timeout: 3600 });
    return true;
  };
  if (sync) {
    drain(work());
    return finish();
  }
  return app.busy('Cropping…', () => drive(work())).then(finish);
}

// ---- the tool -------------------------------------------------------------------------------------------------

export class PerspectiveCropTool extends Tool {
  constructor(app) {
    super(app, {
      id: 'perspective-crop',
      name: 'Perspective Crop Tool',
      icon: 'transform',
      cursor: 'crosshair',
      hint: 'Drag a box and pull its corners onto the subject (or click the four corners), then press Enter. Esc clears the box.',
      options: [
        { kind: 'number', key: 'width', label: 'W', min: 0, max: MAX_SIDE, default: 0, unit: 'px' },
        { kind: 'number', key: 'height', label: 'H', min: 0, max: MAX_SIDE, default: 0, unit: 'px' },
        { kind: 'number', key: 'resolution', label: 'Resolution', min: 0, max: 10000, default: 0, unit: 'ppi' },
        { kind: 'button', key: 'front', label: 'Front Image', onClick: (t) => t.frontImage() },
        { kind: 'button', key: 'clear', label: 'Clear', onClick: (t) => t.clearSize() },
        { kind: 'checkbox', key: 'showGrid', label: 'Show Grid', default: true },
        { kind: 'button', key: 'reset', label: 'Reset', onClick: (t) => t.reset() },
        { kind: 'button', key: 'apply', label: 'Crop', onClick: (t) => t.commit() },
      ],
    });
    this.points = []; // document points; four make the quad
    this.drag = null;
    this.hover = null;
  }
  get complete() {
    return this.points.length === 4;
  }
  activate() {
    this.reset();
  }
  deactivate() {
    this.points = [];
    this.drag = null;
  }
  reset() {
    this.points = [];
    this.drag = null;
    this.view?.invalidate();
    this.app.statusbar.set('hint', this.hint);
  }
  /** Front Image: the size and resolution of the document as it is, so the crop comes out at the same size. */
  frontImage() {
    const d = this.doc;
    if (!d) return;
    this.setOpt('width', d.width);
    this.setOpt('height', d.height);
    this.setOpt('resolution', d.dpi);
  }
  clearSize() {
    for (const k of ['width', 'height', 'resolution']) this.setOpt(k, 0);
  }
  /** Sets the quad from code (tests, scripts): four document points in any order. */
  setQuad(points) {
    this.points = orderQuad(points).map(([x, y]) => ({ x, y }));
    this.view?.invalidate();
  }
  quad() {
    return this.complete ? orderQuad(this.points) : null;
  }
  size() {
    const q = this.quad();
    return q ? outputSize(q, this.opt('width'), this.opt('height')) : null;
  }

  /** What is under the pointer: { corner: i } | { edge: i } (between corner i and i+1) | { move: true } | null. */
  hit(p) {
    if (!this.complete) return null;
    const s = (pt) => this.view.toScreen(pt.x, pt.y);
    const near = (a) => Math.abs(a.x - p.screenX) <= HANDLE && Math.abs(a.y - p.screenY) <= HANDLE;
    for (let i = 0; i < 4; i++) if (near(s(this.points[i]))) return { corner: i };
    for (let i = 0; i < 4; i++) {
      const a = this.points[i], b = this.points[(i + 1) % 4];
      if (near(s({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }))) return { edge: i };
    }
    return pointInPolygon(p, this.points) ? { move: true } : null;
  }

  onPointerDown(p) {
    const h = this.hit(p);
    if (h) this.drag = { ...h, start: p, origin: this.points.map((pt) => ({ ...pt })), moved: false };
    else this.drag = { box: true, start: p, origin: this.points.map((pt) => ({ ...pt })), moved: false };
  }
  onPointerMove(p, dragging) {
    if (!dragging || !this.drag) {
      const h = this.hit(p);
      this.hover = p;
      this.view.setCursor(h?.move ? 'move' : h ? 'pointer' : 'crosshair');
      return;
    }
    const d = this.drag;
    const dx = p.x - d.start.x, dy = p.y - d.start.y;
    if (!d.moved && Math.hypot(p.screenX - d.start.screenX, p.screenY - d.start.screenY) < 3) return;
    d.moved = true;
    const o = d.origin;
    if (d.corner !== undefined) {
      const c = { x: o[d.corner].x + dx, y: o[d.corner].y + dy };
      const sp = this.app.snap?.point(c, { source: 'perspective-crop', pointer: p, view: this.view }) ?? c; // snap (lib/snap.js)
      this.points[d.corner] = { x: sp.x, y: sp.y };
    }
    else if (d.edge !== undefined) {
      for (const i of [d.edge, (d.edge + 1) % 4]) this.points[i] = { x: o[i].x + dx, y: o[i].y + dy };
    } else if (d.move) this.points = o.map((pt) => ({ x: pt.x + dx, y: pt.y + dy }));
    else {
      // a fresh box (replacing whatever was there): its corners are then pulled onto the subject
      const x1 = Math.min(d.start.x, p.x), y1 = Math.min(d.start.y, p.y), x2 = Math.max(d.start.x, p.x), y2 = Math.max(d.start.y, p.y);
      this.points = [{ x: x1, y: y1 }, { x: x2, y: y1 }, { x: x2, y: y2 }, { x: x1, y: y2 }];
    }
    const size = this.size();
    if (size) this.app.statusbar.set('hint', `Perspective crop to ${size.width} × ${size.height} px — Enter crops, Esc clears`);
  }
  onPointerUp(p) {
    const d = this.drag;
    this.drag = null;
    if (!d || p?.cancelled) {
      if (d) this.points = d.origin;
      return;
    }
    if (d.box && !d.moved) {
      // a click: the next corner (a fifth click starts over)
      if (this.complete) this.points = [];
      this.points.push({ x: d.start.x, y: d.start.y });
      if (this.complete) this.points = orderQuad(this.points).map(([x, y]) => ({ x, y }));
    } else if (d.box && this.complete) {
      const q = this.points;
      if (Math.abs(q[1].x - q[0].x) < 2 || Math.abs(q[3].y - q[0].y) < 2) this.points = [];
    } else if (this.complete && d.moved) {
      // a corner dragged past its neighbours: put the corners back in order so the outline never crosses itself
      this.points = orderQuad(this.points).map(([x, y]) => ({ x, y }));
    }
    this.view.invalidate();
  }
  onDoubleClick(p) {
    if (this.complete && this.hit(p)) this.commit();
  }
  commit() {
    if (!this.complete) return false;
    const q = this.quad();
    if (!isConvexQuad(q)) {
      this.app.dialogs.toast('The four corners must form a convex shape: drag them so no corner points inwards', { kind: 'error', timeout: 3200 });
      return true;
    }
    const size = this.size();
    const arg = { quad: q, width: size.width, height: size.height, resolution: Number(this.opt('resolution')) || 0 };
    this.points = [];
    this.view?.invalidate();
    // source 'tool' makes the command crop before it returns (see perspectiveCrop: callers of commit() go straight on)
    this.app.commands.run('image:perspective-crop', arg, 'tool');
    return true;
  }
  cancel() {
    // Escape only belongs to the tool while there is a box (or corners) to throw away
    if (!this.points.length && !this.drag) return false;
    this.reset();
    return true;
  }

  drawOverlay(ctx, view) {
    const pts = this.points.map((p) => view.toScreen(p.x, p.y));
    if (!pts.length) return;
    ctx.save();
    ctx.lineWidth = 1;
    if (!this.complete) {
      // corners placed so far, and a rubber band to the pointer
      ctx.strokeStyle = '#fff';
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      if (this.hover && !this.drag) {
        const h = view.toScreen(this.hover.x, this.hover.y);
        ctx.lineTo(h.x, h.y);
      }
      ctx.stroke();
      handles(ctx, pts, 4);
      ctx.restore();
      return;
    }
    // shade what the crop removes
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.beginPath();
    ctx.rect(0, 0, view.cssWidth, view.cssHeight);
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < 4; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    ctx.fill('evenodd');
    const outline = () => {
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < 4; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.closePath();
    };
    if (this.opt('showGrid') !== false) {
      // the grid lies in the plane of the quad: its lines converge the way the subject's edges do
      try {
        const Hs = T.homography([[0, 0], [1, 0], [1, 1], [0, 1]], pts.map((p) => [p.x, p.y]));
        const n = 8;
        ctx.strokeStyle = 'rgba(255,255,255,0.45)';
        ctx.beginPath();
        for (let i = 1; i < n; i++) {
          const t = i / n;
          const a = T.applyHomography(Hs, t, 0), b = T.applyHomography(Hs, t, 1), c = T.applyHomography(Hs, 0, t), e = T.applyHomography(Hs, 1, t);
          ctx.moveTo(a[0], a[1]);
          ctx.lineTo(b[0], b[1]);
          ctx.moveTo(c[0], c[1]);
          ctx.lineTo(e[0], e[1]);
        }
        ctx.stroke();
      } catch {
        /* three corners in a line: no grid until the quad opens up */
      }
    }
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.lineWidth = 3;
    outline();
    ctx.stroke();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1;
    outline();
    ctx.stroke();
    handles(ctx, pts, 4);
    handles(ctx, pts.map((p, i) => ({ x: (p.x + pts[(i + 1) % 4].x) / 2, y: (p.y + pts[(i + 1) % 4].y) / 2 })), 3);
    const size = this.size();
    if (size) {
      const label = `${size.width} × ${size.height}`;
      const x = Math.min(...pts.map((p) => p.x)), y = Math.min(...pts.map((p) => p.y));
      ctx.font = '11px system-ui';
      ctx.fillStyle = 'rgba(0,0,0,0.7)';
      ctx.fillRect(x, y - 20, ctx.measureText(label).width + 8, 16);
      ctx.fillStyle = '#fff';
      ctx.fillText(label, x + 4, y - 8);
    }
    ctx.restore();
  }
}

function handles(ctx, pts, r) {
  ctx.fillStyle = '#fff';
  ctx.strokeStyle = 'rgba(0,0,0,0.7)';
  ctx.lineWidth = 1;
  for (const p of pts) {
    ctx.fillRect(Math.round(p.x) - r, Math.round(p.y) - r, r * 2, r * 2);
    ctx.strokeRect(Math.round(p.x) - r + 0.5, Math.round(p.y) - r + 0.5, r * 2 - 1, r * 2 - 1);
  }
}

function pointInPolygon(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Registers the tool in the crop slot and the command it commits through. */
export function installPerspectiveCrop(app) {
  const tool = app.tools.register(new PerspectiveCropTool(app), 'crop');
  app.commands.register('image:perspective-crop', {
    enabled: () => !!app.doc,
    run: (arg, ctx) => perspectiveCrop(app, arg ?? {}, { sync: ctx?.source === 'tool' }),
    label: 'Perspective Crop',
  });
  return tool;
}
