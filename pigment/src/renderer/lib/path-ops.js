// Shape rendering and path operations (see ARCHITECTURE.md "0.2 features: path operations").
// Every subpath of a PathData may carry `op`: 'combine' (default) | 'subtract' | 'intersect' | 'exclude'.
// The operations apply in subpath order, Photoshop style: the shape's area is built up on an alpha
// canvas (combine = source-over, subtract = destination-out, intersect = destination-in, exclude =
// xor), the fill paint is drawn through that area and the stroke follows every subpath outline
// (inside / outside alignment is clipped against the combined area).
import { createCanvas, pathToPath2D, makePaint } from './document.js';

export const PATH_OPS = Object.freeze(['combine', 'subtract', 'intersect', 'exclude']);
const COMPOSITE = { combine: 'source-over', subtract: 'destination-out', intersect: 'destination-in', exclude: 'xor' };

/** The operation of a subpath ('combine' when missing or unknown). */
export const subpathOp = (sp) => (sp && PATH_OPS.includes(sp.op) ? sp.op : 'combine');

/** True when any subpath carries an operation other than combine. */
export function hasPathOps(path) {
  return !!path?.subpaths?.some((sp) => subpathOp(sp) !== 'combine');
}

/** Sets `op` on the given subpath indices (all when indices is null); returns a new PathData. */
export function setSubpathOps(path, op, indices = null) {
  const want = PATH_OPS.includes(op) ? op : 'combine';
  const pick = indices ? new Set(indices) : null;
  return {
    subpaths: (path?.subpaths ?? []).map((sp, i) => {
      const copy = { ...sp, points: sp.points.map((p) => ({ ...p })) };
      if (!pick || pick.has(i)) {
        if (want === 'combine') delete copy.op;
        else copy.op = want;
      }
      return copy;
    }),
  };
}

/** Concatenates paths into one; the subpaths of every path after the first take `op`. */
export function combinePaths(paths, op = 'combine') {
  const out = { subpaths: [] };
  paths.forEach((path, i) => {
    for (const sp of path?.subpaths ?? []) {
      const copy = { ...sp, points: sp.points.map((p) => ({ ...p })) };
      if (i > 0) {
        if (op === 'combine' || !PATH_OPS.includes(op)) delete copy.op;
        else copy.op = op;
      }
      out.subpaths.push(copy);
    }
  });
  return out;
}

/**
 * Draws the area of a path (every subpath applied in order with its operation) into ctx, which
 * must be transparent to start with; the result is white where the shape is, alpha = coverage.
 */
export function drawPathArea(ctx, path, offsetX = 0, offsetY = 0) {
  ctx.save();
  ctx.fillStyle = '#ffffff';
  if (!hasPathOps(path)) {
    // no operations: one non-zero fill of the whole path (same result as before 0.2, and faster)
    ctx.globalCompositeOperation = 'source-over';
    ctx.fill(pathToPath2D(path, offsetX, offsetY), 'nonzero');
  } else {
    for (const sp of path.subpaths ?? []) {
      if (!sp.points?.length) continue;
      const op = subpathOp(sp);
      ctx.globalCompositeOperation = COMPOSITE[op];
      // a single subpath is filled with non-zero winding, so its own direction never matters
      ctx.fill(pathToPath2D({ subpaths: [sp] }, offsetX, offsetY), 'nonzero');
    }
  }
  ctx.restore();
}

/**
 * Alpha canvas (width x height) of the area of `path` with its operations applied; (offsetX, offsetY)
 * is subtracted from the path coordinates (pass -bounds.x, -bounds.y to render into a layer canvas).
 * Used by Make Selection, select:from-layer and hit testing.
 */
export function pathAreaCanvas(path, width, height, offsetX = 0, offsetY = 0) {
  const c = createCanvas(Math.max(1, Math.ceil(width)), Math.max(1, Math.ceil(height)));
  const ctx = c.getContext('2d', { willReadFrequently: true });
  drawPathArea(ctx, path, offsetX, offsetY);
  return c;
}

/** Coverage mask (0..255 per pixel, width*height) of the path area. */
export function pathAreaMask(path, width, height, { antialias = true, offsetX = 0, offsetY = 0 } = {}) {
  const c = pathAreaCanvas(path, width, height, offsetX, offsetY);
  const d = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height).data;
  const mask = new Uint8ClampedArray(c.width * c.height);
  for (let i = 0, j = 3; i < mask.length; i++, j += 4) mask[i] = antialias ? d[j] : d[j] >= 128 ? 255 : 0;
  return mask;
}

let hitCanvas = null; // one shared 1x1 canvas, created on first use (document.js imports this module)
/** True when document point (x, y) lies inside the shape area (operations applied). */
export function hitPathArea(path, x, y) {
  hitCanvas ??= createCanvas(1, 1);
  const ctx = hitCanvas.getContext('2d', { willReadFrequently: true });
  ctx.clearRect(0, 0, 1, 1);
  // translate so the point lands on the single pixel
  drawPathArea(ctx, path, -Math.floor(x), -Math.floor(y));
  return ctx.getImageData(0, 0, 1, 1).data[3] > 0;
}

/** Renders a ShapeLayer into `canvas` whose top-left is the document point (b.x, b.y). */
export function renderShapeLayer(layer, canvas, b) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  const rect = { x: 0, y: 0, width: b.width, height: b.height };
  const path = layer.path ?? { subpaths: [] };
  const ops = hasPathOps(path);
  const stroke = layer.stroke && layer.stroke.width > 0 ? layer.stroke : null;
  const align = stroke?.align === 'inside' || stroke?.align === 'outside' ? stroke.align : 'center';
  // the combined area is needed for the fill (through the operations) and for inside/outside strokes
  let area = null;
  if (ops || (stroke && align !== 'center')) area = pathAreaCanvas(path, w, h, -b.x, -b.y);

  if (layer.fill) {
    if (!area) {
      ctx.fillStyle = makePaint(ctx, layer.fill, rect);
      ctx.fill(pathToPath2D(path, -b.x, -b.y), 'nonzero');
    } else {
      // paint through the area: draw the area, then the paint only where it is (source-in)
      const fill = createCanvas(w, h);
      const fctx = fill.getContext('2d');
      fctx.drawImage(area, 0, 0);
      fctx.globalCompositeOperation = 'source-in';
      fctx.fillStyle = makePaint(fctx, layer.fill, rect);
      fctx.fillRect(0, 0, w, h);
      ctx.drawImage(fill, 0, 0);
    }
  }
  if (stroke) {
    const strokeCanvas = align === 'center' ? canvas : createCanvas(w, h);
    const sctx = strokeCanvas.getContext('2d');
    sctx.save();
    // inside/outside: stroke twice as wide, then keep only the half that lies in/out of the area
    sctx.lineWidth = stroke.width * (align === 'center' ? 1 : 2);
    sctx.strokeStyle = makePaint(sctx, stroke.paint ?? { type: 'solid', color: stroke.color ?? '#000' }, rect);
    sctx.lineJoin = stroke.join ?? 'miter';
    sctx.lineCap = stroke.cap ?? 'butt';
    sctx.setLineDash(stroke.dash ?? []);
    sctx.stroke(pathToPath2D(path, -b.x, -b.y));
    if (align !== 'center') {
      sctx.globalCompositeOperation = align === 'inside' ? 'destination-in' : 'destination-out';
      sctx.drawImage(area, 0, 0);
    }
    sctx.restore();
    if (strokeCanvas !== canvas) ctx.drawImage(strokeCanvas, 0, 0);
  }
  return canvas;
}

export { createCanvas };
