// Guide layouts (guides-snapping): the pure maths of View > Guides > New Guide Layout… and New Guides From Shape.
// No DOM: the unit tests check the numbers.
//
// A layout follows Photoshop's dialog: columns (number, width, gutter), rows (number, height, gutter), margins (top,
// left, bottom, right) and Center Columns. The columns fill the area inside the margins; a column width left empty
// shares that area out (after the gutters); a width given places that many columns from the left margin, or centred in
// the area with Center Columns. Rows work the same way from the top margin (they are never centred, as in Photoshop).
// Every column and row contributes its two edges; edges that coincide (no gutter, a column on a margin) give one guide.

const round2 = (v) => Math.round(v * 100) / 100;

/** The normalised layout spec: numbers made finite and non-negative, counts whole. */
export function normalizeLayout(spec = {}) {
  const num = (v, d = 0) => (Number.isFinite(Number(v)) && v !== '' && v !== null ? Math.max(0, Number(v)) : d);
  const size = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) || Number(v) <= 0 ? null : Number(v));
  const c = spec.columns ?? {}, r = spec.rows ?? {}, m = spec.margin ?? {};
  return {
    columns: { enabled: !!c.enabled, number: Math.max(1, Math.round(num(c.number, 1))), width: size(c.width), gutter: num(c.gutter) },
    rows: { enabled: !!r.enabled, number: Math.max(1, Math.round(num(r.number, 1))), height: size(r.height), gutter: num(r.gutter) },
    margin: { enabled: !!m.enabled, top: num(m.top), left: num(m.left), bottom: num(m.bottom), right: num(m.right) },
    center: !!spec.center,
  };
}

/** The edges of `n` tracks of `size` (null: share the span) separated by `gutter` inside [start, end]. */
export function trackEdges(start, end, n, size, gutter, center = false) {
  const span = end - start;
  const w = size ?? (span - gutter * (n - 1)) / n;
  if (!(w > 0)) return [];
  const total = w * n + gutter * (n - 1);
  const x0 = center ? start + (span - total) / 2 : start;
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = x0 + i * (w + gutter);
    out.push(a, a + w);
  }
  return out;
}

/** Sorted unique positions (to 1/100 px). */
function unique(list) {
  const seen = new Set();
  const out = [];
  for (const v of list.map(round2).sort((a, b) => a - b)) {
    const key = Object.is(v, -0) ? 0 : v;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/**
 * The guides of a layout on a document of { width, height }: [{ axis: 'x' | 'y', pos }], vertical guides first, each
 * axis in order. Positions are document px from the canvas corner (not the ruler origin), rounded to 1/100 px.
 */
export function guideLayout(spec, { width, height }) {
  const s = normalizeLayout(spec);
  const m = s.margin.enabled ? s.margin : { top: 0, left: 0, bottom: 0, right: 0 };
  const xs = [], ys = [];
  if (s.margin.enabled) {
    xs.push(m.left, width - m.right);
    ys.push(m.top, height - m.bottom);
  }
  if (s.columns.enabled) xs.push(...trackEdges(m.left, width - m.right, s.columns.number, s.columns.width, s.columns.gutter, s.center));
  if (s.rows.enabled) ys.push(...trackEdges(m.top, height - m.bottom, s.rows.number, s.rows.height, s.rows.gutter, false));
  return [...unique(xs).map((pos) => ({ axis: 'x', pos })), ...unique(ys).map((pos) => ({ axis: 'y', pos }))];
}

/**
 * New Guides From Shape: guides on the left, centre and right and on the top, middle and bottom of a bounding box
 * (document px), as Photoshop places them around a shape layer.
 */
export function guidesFromBounds(b) {
  if (!b || !(b.width >= 0) || !(b.height >= 0)) return [];
  const xs = unique([b.x, b.x + b.width / 2, b.x + b.width]);
  const ys = unique([b.y, b.y + b.height / 2, b.y + b.height]);
  return [...xs.map((pos) => ({ axis: 'x', pos })), ...ys.map((pos) => ({ axis: 'y', pos }))];
}

/** Merges new guides into a list: a guide already there (same axis, same position to 1/100 px) is not doubled. */
export function mergeGuides(existing, added) {
  const key = (g) => `${g.axis}:${round2(g.pos)}`;
  const seen = new Set(existing.map(key));
  const out = [...existing];
  for (const g of added) {
    if (seen.has(key(g))) continue;
    seen.add(key(g));
    out.push(g);
  }
  return out;
}
