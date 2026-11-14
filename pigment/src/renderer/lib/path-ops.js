// Shape rendering and path operations (see ARCHITECTURE.md "0.2 features: path operations").
// Every subpath of a PathData may carry `op`: 'combine' (default) | 'subtract' | 'intersect' | 'exclude'.
// The operations apply in subpath order, Photoshop style: the shape's area is built up on an alpha
// canvas (combine = source-over, subtract = destination-out, intersect = destination-in, exclude =
// xor), the fill paint is drawn through that area and the stroke follows every subpath outline
// (inside / outside alignment is clipped against the combined area).
import { createCanvas, pathToPath2D, pathBounds } from './document.js';
import { paintStyle } from './paint.js';
import { strokeReach, shapePath, mapLiveProps, fitAffine } from './shape-geometry.js';

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

// ---- shape layers: bounds and rendering (shapes-live, J.5, G.3) ------------------------------------------------------

/**
 * The box a ShapeLayer renders into (document px), padded for its stroke; null for an empty path. ShapeLayer.bounds()
 * delegates here (J.5): the padding is what the stroke reaches outside the outline (half the width centred, the width
 * outside, nothing inside; miter joins and square caps further, shape-geometry.js strokeReach) plus 1 px for
 * anti-aliasing. Arrowheads are part of a line's path, so the path bounds hold them.
 */
export function shapeBounds(layer) {
  const b = pathBounds(layer.path ?? { subpaths: [] });
  if (!b) return null;
  const stroke = activeStroke(layer);
  const pad = Math.ceil((stroke ? strokeReach(stroke) : 0) + 1);
  return { x: Math.floor(b.x) - pad, y: Math.floor(b.y) - pad, width: Math.ceil(b.width) + pad * 2 + 1, height: Math.ceil(b.height) + pad * 2 + 1 };
}

/**
 * The box a shape layer's drawn content occupies (document px, not rounded): the path bounds plus what the stroke
 * covers outside the outline (half the width centred, the width outside, nothing inside), without shapeBounds' render
 * padding. Align, Free Transform, quick Rotate/Flip and Reveal All use it: the padded box is 1 px wider on the left and
 * 2 px on the right, so it put shapes 1 to 2 px off and moved the transform pivot by half a pixel, and every rotate or
 * flip then shifted the shape. Miter spikes past the outline are left out, as Photoshop measures a shape by its edges.
 */
export function shapeContentBounds(layer) {
  const b = pathBounds(layer.path ?? { subpaths: [] });
  if (!b) return null;
  const stroke = activeStroke(layer);
  const w = stroke ? Number(stroke.width) || 0 : 0;
  const out = !stroke ? 0 : stroke.align === 'inside' ? 0 : stroke.align === 'outside' ? w : w / 2;
  return { x: b.x - out, y: b.y - out, width: b.width + out * 2, height: b.height + out * 2 };
}

/** The stroke a shape layer draws, or null (none, zero width or a null paint). */
export function activeStroke(layer) {
  const s = layer?.stroke;
  if (!s || !(s.width > 0) || s.paint === null) return null;
  return s;
}

/** The paint of a stroke: `paint` wins over 0.3's `color` (J.5). */
export function strokePaintOf(stroke) {
  if (!stroke) return null;
  if (stroke.paint) return stroke.paint;
  return { type: 'solid', color: stroke.color ?? '#000000' };
}

// Pattern paints of shapes keep their pixels as `dataUrl` next to the runtime canvas (a .pigment file or an action
// stores the paint as JSON, which drops the canvas): a paint whose canvas is gone is decoded once, then the layer
// redraws. shape-props.js sets the hook that tells the view.
const decoded = new Map(); // dataUrl -> HTMLCanvasElement | null (null while decoding)
let onPatternReady = null;
export function setShapePatternListener(fn) {
  onPatternReady = typeof fn === 'function' ? fn : null;
}
const drawable = (c) => !!c && (typeof c.getContext === 'function' || (typeof ImageBitmap !== 'undefined' && c instanceof ImageBitmap));

/** The canvas of a pattern paint's dataUrl: the decoded canvas, or null while it decodes (then layer is touched). */
export function patternCanvasFromUrl(url, layer = null) {
  if (decoded.has(url)) return decoded.get(url);
  decoded.set(url, null);
  if (typeof Image === 'undefined') return null;
  const img = new Image();
  img.onload = () => {
    const c = createCanvas(img.naturalWidth || 1, img.naturalHeight || 1);
    c.getContext('2d').drawImage(img, 0, 0);
    decoded.set(url, c);
    if (layer) {
      layer.touch?.();
      onPatternReady?.(layer);
    }
  };
  img.onerror = () => decoded.delete(url);
  img.src = url;
  return null;
}

/** A paint ready to draw: a pattern paint without its canvas gets it back from `dataUrl`; null when not drawable yet. */
export function drawablePaint(paint, layer = null) {
  if (!paint || paint.type !== 'pattern') return paint;
  const p = paint.pattern;
  if (drawable(p?.canvas)) return paint;
  if (typeof p?.dataUrl !== 'string') return null;
  const canvas = patternCanvasFromUrl(p.dataUrl, layer);
  return canvas ? { ...paint, pattern: { ...p, canvas } } : null;
}

/**
 * Renders a ShapeLayer into `canvas` whose top-left is the document point (b.x, b.y). Paints are placed against the
 * path bounds without the stroke padding, with origin = the canvas's document position (G.3), so a wider stroke or a
 * moved shape keeps its gradient and pattern where they were on the shape. Strokes: alignment (inside and outside are
 * a double-width stroke clipped against the combined area), caps, joins, miter limit and dashes in stroke widths.
 */
export function renderShapeLayer(layer, canvas, b) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  const path = layer.path ?? { subpaths: [] };
  const pb = pathBounds(path);
  const box = pb ? { x: pb.x - b.x, y: pb.y - b.y, width: pb.width, height: pb.height } : { x: 0, y: 0, width: b.width, height: b.height };
  const opts = { origin: [b.x, b.y], layer };
  const ops = hasPathOps(path);
  const stroke = activeStroke(layer);
  const align = stroke?.align === 'inside' || stroke?.align === 'outside' ? stroke.align : 'center';
  // the combined area is needed for the fill (through the operations) and for inside/outside strokes
  let area = null;
  if (ops || (stroke && align !== 'center')) area = pathAreaCanvas(path, w, h, -b.x, -b.y);

  const fill = drawablePaint(layer.fill, layer);
  if (fill) {
    if (!area) {
      ctx.fillStyle = paintStyle(ctx, fill, box, opts);
      ctx.fill(pathToPath2D(path, -b.x, -b.y), 'nonzero');
    } else {
      // paint through the area: draw the area, then the paint only where it is (source-in)
      const fc = createCanvas(w, h);
      const fctx = fc.getContext('2d');
      fctx.drawImage(area, 0, 0);
      fctx.globalCompositeOperation = 'source-in';
      fctx.fillStyle = paintStyle(fctx, fill, box, opts);
      fctx.fillRect(0, 0, w, h);
      ctx.drawImage(fc, 0, 0);
    }
  }
  const sp = stroke ? drawablePaint(strokePaintOf(stroke), layer) : null;
  if (stroke && sp) {
    const strokeCanvas = align === 'center' ? canvas : createCanvas(w, h);
    const sctx = strokeCanvas.getContext('2d');
    sctx.save();
    // inside/outside: stroke twice as wide, then keep only the half that lies in/out of the area
    sctx.lineWidth = stroke.width * (align === 'center' ? 1 : 2);
    sctx.strokeStyle = paintStyle(sctx, sp, box, opts);
    sctx.lineJoin = ['miter', 'round', 'bevel'].includes(stroke.join) ? stroke.join : 'miter';
    sctx.lineCap = ['butt', 'round', 'square'].includes(stroke.cap) ? stroke.cap : 'butt';
    sctx.miterLimit = Math.max(1, Number.isFinite(stroke.miterLimit) ? stroke.miterLimit : 4);
    const dash = dashPattern(stroke);
    sctx.setLineDash(dash);
    if (dash.length) sctx.lineDashOffset = (Number(stroke.dashOffset) || 0) * stroke.width;
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

/**
 * The Canvas dash list of a stroke in px: `dash` is in stroke widths (J.5); a zero-length dash (the dotted preset)
 * becomes a hair so round and square caps still draw their dot. Empty for a solid stroke.
 */
export function dashPattern(stroke) {
  const list = Array.isArray(stroke?.dash) ? stroke.dash.map((v) => Math.max(0, Number(v) || 0)) : [];
  if (!list.length || list.every((v) => v === 0)) return [];
  const w = stroke.width;
  const cap = stroke.cap === 'round' || stroke.cap === 'square';
  return list.map((v, i) => (i % 2 === 0 && v === 0 && cap ? 0.001 : v * w));
}

// ---- live shapes: reading 0.3 parameters and mapping shape geometry (ARCHITECTURE.md "0.4 features", J.5) -----------
// Owned by shapes-live; the skeleton lands the reading table and a stub of the mapping that keeps 0.3 behaviour.

const num = (v, d = 0) => (Number.isFinite(v) ? v : d);
const ARROW_03 = Object.freeze({ width: 500, length: 500, concavity: 0 }); // 0.3's head: max(6 px, 5 x weight)
const arrowOf = (a) => (a === true ? { ...ARROW_03 } : a && typeof a === 'object' ? { width: num(a.width, 500), length: num(a.length, 500), concavity: num(a.concavity, 0) } : null);
const box = (p) => ({ x: num(p.x), y: num(p.y), width: num(p.width), height: num(p.height), angle: num(p.angle) });

/**
 * The live parameters of a shape layer as 0.4 reads them: { kind, props }. 0.3 files store box-based props
 * ({ x, y, width, height, radius } rectangles, polygons with `star` / `inset`, lines with boolean arrows); they are
 * read here lazily and rewritten only when the user edits the shape, so 0.3 files stay byte-stable. Kind 'path' is
 * not live (every reshaped shape, and custom shapes, which 0.3 cannot tell from an edited one).
 */
export function normalizeShapeProps(layer) {
  const kind = layer?.shapeKind ?? 'path';
  const p = layer?.shapeProps && typeof layer.shapeProps === 'object' ? layer.shapeProps : {};
  switch (kind) {
    case 'rect': {
      const r = num(p.radius);
      const radii = Array.isArray(p.radii) && p.radii.length === 4 ? p.radii.map((v) => num(v)) : [r, r, r, r];
      return { kind, props: { ...box(p), radii } };
    }
    case 'ellipse': return { kind, props: box(p) };
    case 'triangle': return { kind, props: { ...box(p), radius: num(p.radius) } };
    case 'polygon': return {
      kind,
      props: {
        ...box(p),
        sides: Math.max(3, Math.round(num(p.sides, 5))),
        starRatio: Number.isFinite(p.starRatio) ? p.starRatio : p.star ? 100 - num(p.inset, 50) : 100,
        smoothCorners: !!p.smoothCorners,
        smoothIndents: !!p.smoothIndents,
        cornerRadius: num(p.cornerRadius),
      },
    };
    case 'line': return { kind, props: { x1: num(p.x1), y1: num(p.y1), x2: num(p.x2), y2: num(p.y2), weight: num(p.weight, 1), arrowStart: arrowOf(p.arrowStart), arrowEnd: arrowOf(p.arrowEnd) } };
    case 'custom': return { kind, props: { ...box(p), shape: p.shape ?? null } };
    default: return { kind: 'path', props: { ...p } };
  }
}

/** PathData through pointFn(x, y) -> [x, y] (anchors and handles). */
export function mapPathPoints(path, f) {
  return {
    ...path,
    subpaths: (path?.subpaths ?? []).map((sp) => ({
      ...sp,
      points: (sp.points ?? []).map((pt) => {
        const q = { ...pt };
        [q.x, q.y] = f(pt.x, pt.y);
        if (pt.inX !== undefined) [q.inX, q.inY] = f(pt.inX, pt.inY);
        if (pt.outX !== undefined) [q.outX, q.outY] = f(pt.outX, pt.outY);
        return q;
      }),
    })),
  };
}

const X_KEYS = ['x', 'x1', 'x2', 'cx'], Y_KEYS = ['y', 'y1', 'y2', 'cy'];
const mapPaint = (paint, f) => {
  const g = paint?.type === 'gradient' ? paint.gradient : null;
  if (!g?.from || !g?.to) return paint;
  return { ...paint, gradient: { ...g, from: f(...g.from), to: f(...g.to) } };
};

/** True when the layer is a live shape: its parameters regenerate its path (J.5). */
export function isLiveShape(layer) {
  if (!layer || (layer.type && layer.type !== 'shape')) return false;
  return normalizeShapeProps(layer).kind !== 'path';
}

// The 0..1 path of a 'shapes' preset for live custom shapes; shape-props.js sets it (app.presets), the fallback is
// tools/vector.js CUSTOM_SHAPES through shape-geometry.js.
let customPathOf = null;
export function setCustomShapeResolver(fn) {
  customPathOf = typeof fn === 'function' ? fn : null;
}

/** The path of live parameters (normalised or 0.3 form), or null for kind 'path'. */
export function livePath(kind, props) {
  const n = normalizeShapeProps({ shapeKind: kind, shapeProps: props });
  return n.kind === 'path' ? null : shapePath(n.kind, n.props, { customPathOf });
}

/** The layer's path regenerated from its parameters: { path, shapeKind, shapeProps } (props normalised), or null. */
export function regenerateShape(layer, patch = null) {
  const n = normalizeShapeProps(layer);
  if (n.kind === 'path') return null;
  const props = patch ? { ...n.props, ...patch } : n.props;
  return { path: shapePath(n.kind, props, { customPathOf }), shapeKind: n.kind, shapeProps: props };
}

/** A new stroke's settings (Photoshop's defaults; J.5). */
export const DEFAULT_STROKE = Object.freeze({ width: 3, align: 'center', cap: 'butt', join: 'miter', miterLimit: 4, dash: Object.freeze([]), dashOffset: 0 });

/**
 * The layer patch of a shape edit (Properties, the options bar, the corner widgets, Paste Shape Attributes), or null
 * when nothing changes: `props` patches the live parameters and regenerates the path (ignored on a non-live shape),
 * `fill` replaces the fill (null = none), `stroke` is null (no stroke) or a patch of the stroke (a missing stroke
 * starts from DEFAULT_STROKE in black). A solid stroke paint also writes 0.3's `color`, so Pigment 0.3 reads it.
 */
export function shapeChangePatch(layer, { props, fill, stroke } = {}) {
  const patch = {};
  if (props && typeof props === 'object') {
    const g = regenerateShape(layer, props);
    if (g) Object.assign(patch, g);
  }
  if (fill !== undefined) patch.fill = fill ?? null;
  if (stroke === null) patch.stroke = null;
  else if (stroke && typeof stroke === 'object') {
    const base = layer.stroke ?? { ...DEFAULT_STROKE, color: '#000000', paint: { type: 'solid', color: '#000000' } };
    const next = { ...base, ...stroke, dash: Array.isArray(stroke.dash) ? stroke.dash.slice() : Array.isArray(base.dash) ? base.dash.slice() : [] };
    if (stroke.paint?.type === 'solid') next.color = stroke.paint.color;
    else if (typeof stroke.color === 'string' && !('paint' in stroke)) next.paint = { type: 'solid', color: stroke.color };
    if (!next.paint && typeof next.color === 'string') next.paint = { type: 'solid', color: next.color };
    patch.stroke = next;
  }
  return Object.keys(patch).length ? patch : null;
}

/**
 * What a move or transform of a shape layer assigns: { path, shapeKind, shapeProps, fill?, stroke? } (fill and stroke
 * only when a paint carried document-space from / to). `pointFn` maps a document point; `matrix` (affine) or
 * `homography` say what it is (without either, the transform is fitted from pointFn).
 * - A pure translation shifts the stored numbers (0.3's keys, the stored form kept) and the path.
 * - Otherwise a live shape keeps its kind when the transform is affine and maps it to the same kind: rotation goes
 *   into `angle`, scale into the box and the radii, the path is regenerated (custom shapes map their path, which is
 *   the same thing for them); a skew, a perspective or a mirrored custom shape makes it shapeKind 'path' with the
 *   path mapped point by point. Strokes keep their width (the callers scale it where they mean to).
 */
export function mapShapeGeometry(layer, pointFn, { matrix = null, homography = null } = {}) {
  const src = layer.path ?? { subpaths: [] };
  const kind = layer.shapeKind ?? 'path';
  const stored = { ...(layer.shapeProps ?? {}) };
  let m = Array.isArray(matrix) && matrix.length >= 6 ? matrix : null;
  if (!m && (homography || !matrix)) {
    const pb = pathBounds(src);
    m = pb ? fitAffine(pointFn, pb) : null;
  }
  let out;
  if (m && m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1) {
    out = { path: mapPathPoints(src, pointFn), shapeKind: kind, shapeProps: stored };
    const [dx, dy] = [m[4], m[5]];
    if (dx || dy) {
      for (const k of X_KEYS) if (typeof out.shapeProps[k] === 'number') out.shapeProps[k] += dx;
      for (const k of Y_KEYS) if (typeof out.shapeProps[k] === 'number') out.shapeProps[k] += dy;
    }
  } else {
    const n = normalizeShapeProps(layer);
    const props = n.kind !== 'path' && m ? mapLiveProps(n.kind, n.props, m) : null;
    if (props && n.kind === 'custom') out = { path: mapPathPoints(src, pointFn), shapeKind: 'custom', shapeProps: props };
    else if (props) out = { path: shapePath(n.kind, props, { customPathOf }), shapeKind: n.kind, shapeProps: props };
    else out = { path: mapPathPoints(src, pointFn), shapeKind: 'path', shapeProps: stored };
  }
  const fill = mapPaint(layer.fill, pointFn);
  if (fill !== layer.fill) out.fill = fill;
  const strokePaint = layer.stroke?.paint ? mapPaint(layer.stroke.paint, pointFn) : null;
  if (strokePaint && strokePaint !== layer.stroke.paint) out.stroke = { ...layer.stroke, paint: strokePaint };
  return out;
}

export { createCanvas };
