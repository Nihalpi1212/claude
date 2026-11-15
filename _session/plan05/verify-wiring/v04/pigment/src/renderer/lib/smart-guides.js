// Smart Guides (guides-snapping): the magenta lines that show what a moved layer or box lines up with, the equal
// spacing marks, and the distances Ctrl/Cmd-hover measures with the Move tool. The geometry is pure (unit tests check
// it); drawSmartOverlay paints an overlay in screen space through the view, as the other canvas overlays do.
//
// Boxes are { x, y, width, height } in document px. An axis 'x' line is vertical (x = pos, from y = from to y = to);
// an axis 'x' gap is a horizontal measurement (from x = from to x = to, drawn at y = at).

const EPS = 0.5; // document px: closer than this counts as aligned (moves are rounded to whole pixels)

const lo = (b, axis) => (axis === 'x' ? b.x : b.y);
const size = (b, axis) => (axis === 'x' ? b.width : b.height);
const hi = (b, axis) => lo(b, axis) + size(b, axis);
const mid = (b, axis) => lo(b, axis) + size(b, axis) / 2;
const other = (axis) => (axis === 'x' ? 'y' : 'x');

/** [start, centre, end] of a box along an axis. */
export function boxEdges(b, axis) {
  return [lo(b, axis), mid(b, axis), hi(b, axis)];
}

/** True when two boxes overlap along an axis (touching does not count). */
export function overlaps(a, b, axis) {
  return lo(a, axis) < hi(b, axis) && lo(b, axis) < hi(a, axis);
}

/**
 * The alignment lines of a box among others: for every edge or centre of `rect` that meets an edge or centre of
 * another box, a line through both boxes. Lines at the same position merge into one long line.
 */
export function alignmentLines(rect, boxes, { eps = EPS } = {}) {
  const lines = [];
  for (const axis of ['x', 'y']) {
    const across = other(axis);
    const byPos = new Map();
    const mine = boxEdges(rect, axis);
    for (const b of boxes) {
      const theirs = boxEdges(b, axis);
      for (const e of mine) {
        if (!theirs.some((t) => Math.abs(t - e) <= eps)) continue;
        const key = Math.round(e * 2) / 2;
        const from = Math.min(lo(rect, across), lo(b, across));
        const to = Math.max(hi(rect, across), hi(b, across));
        const cur = byPos.get(key);
        byPos.set(key, cur ? { axis, pos: e, from: Math.min(cur.from, from), to: Math.max(cur.to, to) } : { axis, pos: e, from, to });
      }
    }
    lines.push(...byPos.values());
  }
  return lines;
}

/**
 * Equal-spacing targets along an axis: positions where `rect` would sit as far from a neighbour as two other boxes in
 * its row (or column) sit from each other, or exactly between two boxes. Each target restricts the edge that may meet
 * it ('start', 'centre' or 'end') and carries the gap segments to draw: `segments` are [from, to, at] (at null: the
 * moved box's middle).
 */
export function spacingTargets(rect, boxes, axis) {
  const across = other(axis);
  const row = boxes.filter((b) => overlaps(b, rect, across) && size(b, axis) > 0).sort((a, b) => lo(a, axis) - lo(b, axis));
  const out = [];
  const w = size(rect, axis);
  for (let i = 0; i + 1 < row.length; i++) {
    const a = row[i], c = row[i + 1];
    const gap = lo(c, axis) - hi(a, axis);
    if (!(gap > 0)) continue;
    const at = (Math.max(lo(a, across), lo(c, across)) + Math.min(hi(a, across), hi(c, across))) / 2;
    const ref = [hi(a, axis), lo(c, axis), at];
    // after the pair, or before it, with the same gap
    out.push({ pos: hi(c, axis) + gap, kind: 'layer', edge: 'start', spacing: { gap, segments: [ref, [hi(c, axis), hi(c, axis) + gap, null]] } });
    out.push({ pos: lo(a, axis) - gap, kind: 'layer', edge: 'end', spacing: { gap, segments: [ref, [lo(a, axis) - gap, lo(a, axis), null]] } });
    // centred between the two
    if (gap > w) {
      const half = (gap - w) / 2;
      const centre = (hi(a, axis) + lo(c, axis)) / 2;
      out.push({ pos: centre, kind: 'layer', edge: 'centre', spacing: { gap: half, segments: [[hi(a, axis), hi(a, axis) + half, null], [lo(c, axis) - half, lo(c, axis), null]] } });
    }
  }
  return out;
}

/**
 * What Ctrl/Cmd-hover measures between the selected box `a` and the box under the pointer `b` (or the canvas): per
 * axis, the gap between them when they are apart, else the distances between their facing edges. Zero distances are
 * left out.
 */
export function distances(a, b) {
  const out = [];
  for (const axis of ['x', 'y']) {
    const across = other(axis);
    const at = overlaps(a, b, across)
      ? (Math.max(lo(a, across), lo(b, across)) + Math.min(hi(a, across), hi(b, across))) / 2
      : mid(a, across);
    const seg = (from, to) => {
      if (Math.abs(to - from) > 1e-9) out.push({ axis, from: Math.min(from, to), to: Math.max(from, to), at });
    };
    if (hi(a, axis) <= lo(b, axis)) seg(hi(a, axis), lo(b, axis));
    else if (hi(b, axis) <= lo(a, axis)) seg(hi(b, axis), lo(a, axis));
    else {
      seg(lo(a, axis), lo(b, axis));
      seg(hi(a, axis), hi(b, axis));
    }
  }
  return out;
}

/** The gap segments of a snapped spacing target for the moved box (at null becomes the box's middle). */
export function spacingMarks(rect, target, axis) {
  if (!target?.spacing) return [];
  const across = other(axis);
  return target.spacing.segments.map(([from, to, at]) => ({ axis, from, to, at: at ?? mid(rect, across) }));
}

/**
 * Paints an overlay { lines, gaps } in screen space. `format(axis, length)` labels a gap (ruler units). Lines are
 * drawn across the whole view when they come from a guide-like target (`full`), else between the boxes they join.
 */
export function drawSmartOverlay(ctx, view, overlay, { color = '#ff00ff', format = (axis, v) => String(Math.round(v)) } = {}) {
  if (!overlay) return;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 1;
  ctx.setLineDash([]);
  for (const l of overlay.lines ?? []) {
    const a = l.axis === 'x' ? view.toScreen(l.pos, l.from) : view.toScreen(l.from, l.pos);
    const b = l.axis === 'x' ? view.toScreen(l.pos, l.to) : view.toScreen(l.to, l.pos);
    ctx.beginPath();
    if (!view.rotation) {
      if (l.axis === 'x') {
        const x = Math.round(a.x) + 0.5;
        ctx.moveTo(x, a.y);
        ctx.lineTo(x, b.y);
      } else {
        const y = Math.round(a.y) + 0.5;
        ctx.moveTo(a.x, y);
        ctx.lineTo(b.x, y);
      }
    } else {
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
    }
    ctx.stroke();
  }
  ctx.font = '10px system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  for (const g of overlay.gaps ?? []) {
    const a = g.axis === 'x' ? view.toScreen(g.from, g.at) : view.toScreen(g.at, g.from);
    const b = g.axis === 'x' ? view.toScreen(g.to, g.at) : view.toScreen(g.at, g.to);
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    // end ticks across the measurement
    const ux = len ? (b.x - a.x) / len : 1, uy = len ? (b.y - a.y) / len : 0;
    for (const p of [a, b]) {
      ctx.moveTo(p.x - uy * 4, p.y + ux * 4);
      ctx.lineTo(p.x + uy * 4, p.y - ux * 4);
    }
    ctx.stroke();
    if (g.label !== false) {
      const text = format(g.axis, g.to - g.from);
      const w = ctx.measureText(text).width + 8;
      const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
      ctx.fillStyle = color;
      ctx.fillRect(Math.round(cx - w / 2), Math.round(cy - 7), Math.round(w), 14);
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'center';
      ctx.fillText(text, Math.round(cx), Math.round(cy) + 0.5);
      ctx.fillStyle = color;
    }
  }
  ctx.restore();
}
