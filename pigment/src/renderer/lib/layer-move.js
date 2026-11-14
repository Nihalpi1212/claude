// Moving layers by an offset, undoably. Positions are captured once and every move is applied
// from that original state (no accumulated drift), covering raster x/y, text positions and
// transforms, shape geometry, group children and linked masks (masks are document-sized canvases,
// so a moved mask is a new shifted canvas; the original is kept for undo). A linked vector mask (0.4) moves
// with its layer; shapes move through path-ops.js mapShapeGeometry (J.2), so their live parameters follow.
import { createCanvas } from './document.js';
import { mapShapeGeometry, mapPathPoints } from './path-ops.js';

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

/** The mask moved by (dx, dy); uncovered areas take the mask's background (its corner pixel). */
function shiftedMask(src, dx, dy) {
  const c = createCanvas(src.width, src.height);
  const ctx = c.getContext('2d');
  let bg = 0;
  try {
    bg = src.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, 1, 1).data[3];
  } catch {
    /* ignore */
  }
  if (bg) {
    ctx.fillStyle = `rgba(255,255,255,${bg / 255})`;
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.clearRect(dx, dy, src.width, src.height);
  }
  ctx.drawImage(src, dx, dy);
  return c;
}

function captureState(l) {
  const s = { l };
  if (!l.isGroup && typeof l.x === 'number') {
    s.x = l.x;
    s.y = l.y;
  }
  if (l.type === 'text') s.transform = l.transform ? l.transform.slice() : null;
  if (l.type === 'shape') {
    s.path = clone(l.path);
    s.shape = { shapeKind: l.shapeKind, shapeProps: clone(l.shapeProps), fill: l.fill, stroke: l.stroke };
  }
  if (l.mask?.canvas) s.mask = l.mask;
  if (l.vectorMask) s.vectorMask = l.vectorMask;
  if (linkedPattern(l)) s.paint = l.paint;
  return s;
}

/** A Pattern Fill layer whose pattern is linked with the layer (G.2; 0.3 paints have no `link` and stay put). */
const linkedPattern = (l) => l.type === 'fill' && l.paint?.type === 'pattern' && l.paint.pattern?.link === true;

function shiftedState(s, dx, dy) {
  const n = { ...s };
  const l = s.l;
  if (l.type === 'text' && s.transform) {
    n.transform = s.transform.slice();
    n.transform[4] += dx;
    n.transform[5] += dy;
  } else if (s.x !== undefined) {
    n.x = s.x + dx;
    n.y = s.y + dy;
  }
  const shift = (x, y) => [x + dx, y + dy];
  if (l.type === 'shape' && s.path) {
    // mapShapeGeometry (path-ops.js, shapes-live) maps the path, the live parameters and any document-space paint
    const g = mapShapeGeometry({ ...s.shape, path: s.path }, shift, { matrix: [1, 0, 0, 1, dx, dy] });
    n.path = g.path;
    n.shape = { shapeKind: g.shapeKind, shapeProps: g.shapeProps, fill: g.fill ?? s.shape.fill, stroke: g.stroke ?? s.shape.stroke };
  }
  if (s.mask && s.mask.linked !== false && (dx || dy)) n.mask = { ...s.mask, canvas: shiftedMask(s.mask.canvas, dx, dy) };
  if (s.vectorMask && s.vectorMask.linked !== false && (dx || dy)) n.vectorMask = { ...s.vectorMask, path: mapPathPoints(s.vectorMask.path, shift) };
  if (s.paint && (dx || dy)) {
    // Link with Layer: moving a Pattern Fill layer moves its pattern (Photoshop)
    const o = Array.isArray(s.paint.pattern.origin) ? s.paint.pattern.origin : [0, 0];
    n.paint = { ...s.paint, pattern: { ...s.paint.pattern, origin: [(Number(o[0]) || 0) + dx, (Number(o[1]) || 0) + dy] } };
  }
  return n;
}

function applyState(s) {
  const l = s.l;
  if (s.x !== undefined) {
    l.x = s.x;
    l.y = s.y;
  }
  if ('transform' in s) l.transform = s.transform ? s.transform.slice() : null;
  if (s.path) l.path = clone(s.path);
  if (s.shape) {
    l.shapeKind = s.shape.shapeKind;
    l.shapeProps = clone(s.shape.shapeProps);
    l.fill = s.shape.fill;
    l.stroke = s.shape.stroke;
  }
  if (s.mask) l.mask = s.mask;
  if (s.vectorMask) l.vectorMask = s.vectorMask;
  if (s.paint) l.paint = s.paint;
  l.touch();
}

/** Every layer that moves with `layers` (groups contribute their descendants). */
function collect(layers) {
  const out = new Set();
  const walk = (l) => {
    if (out.has(l)) return;
    out.add(l);
    if (l.isGroup) for (const c of l.children) walk(c);
  };
  layers.forEach(walk);
  // fill and adjustment layers have no position of their own; only their (linked) masks and linked patterns move
  return [...out].filter((l) => !(l.type === 'fill' || l.type === 'adjustment' || l.isGroup) || l.mask?.canvas || l.vectorMask || linkedPattern(l));
}

/**
 * Starts moving layers. Returns { set(dx, dy) to preview, reset(), commit(label) -> pushes one undo
 * entry (or nothing when unmoved), dx, dy }.
 */
export function beginLayerMove(doc, layers) {
  const before = collect(layers).map(captureState);
  let current = before;
  const session = {
    dx: 0,
    dy: 0,
    set(dx, dy) {
      session.dx = dx;
      session.dy = dy;
      current = before.map((s) => shiftedState(s, dx, dy));
      for (const s of current) applyState(s);
      doc.changed('props');
    },
    reset() {
      session.dx = session.dy = 0;
      for (const s of before) applyState(s);
      current = before;
      doc.changed('props');
    },
    commit(label = 'Move') {
      if (!session.dx && !session.dy) return null;
      const after = current;
      const apply = (states) => {
        for (const s of states) applyState(s);
        doc.changed('props');
      };
      const bytes = after.reduce((n, s, i) => n + (s.mask && s.mask !== before[i].mask ? s.mask.canvas.width * s.mask.canvas.height * 4 : 0), 0);
      const entry = { label, undo: () => apply(before), redo: () => apply(after), bytes, at: Date.now() };
      doc.history.push(entry);
      doc.changed('history');
      return entry;
    },
  };
  return session;
}

/** Moves layers by (dx, dy) as one undo step. */
export function offsetLayers(doc, layers, dx, dy, label = 'Move') {
  if (!dx && !dy) return null;
  const m = beginLayerMove(doc, layers);
  m.set(dx, dy);
  return m.commit(label);
}

/** Moves each layer by its own offset as one undo step: moves = [{ layer, dx, dy }]. */
export function offsetEach(doc, moves, label = 'Move') {
  const sessions = moves.filter((m) => m.dx || m.dy).map((m) => ({ m, s: beginLayerMove(doc, [m.layer]) }));
  if (!sessions.length) return;
  doc.history.group(label, () => {
    for (const { m, s } of sessions) {
      s.set(m.dx, m.dy);
      s.commit(label);
    }
  });
}
